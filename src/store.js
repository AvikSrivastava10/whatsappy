import { DatabaseSync } from 'node:sqlite';
import { validateQuestion, contentHash } from './content.js';
import { schedule } from './schedule.js';

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS questions (week INTEGER PRIMARY KEY, body TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, approved INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, week INTEGER NOT NULL REFERENCES questions(week), group_id TEXT NOT NULL,
        kind TEXT NOT NULL, due INTEGER NOT NULL, deadline INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt INTEGER NOT NULL DEFAULT 0, lease INTEGER, message_id TEXT, error TEXT, UNIQUE(week,group_id,kind));
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, job_id INTEGER, at INTEGER NOT NULL, event TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  getMeta(key) { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value; }
  setMeta(key, value) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, String(value)); }
  saveQuestion(input) {
    const q = validateQuestion(input);
    this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM jobs WHERE week=?').get(q.week)) throw new Error('Scheduled questions are immutable; use a different week or an explicit correction outside the bot');
      this.db.prepare('INSERT INTO questions VALUES (?,?,?,0) ON CONFLICT(week) DO UPDATE SET body=excluded.body,hash=excluded.hash,approved=0').run(q.week, JSON.stringify(q), contentHash(q));
    });
    return q;
  }
  question(week) { const row = this.db.prepare('SELECT * FROM questions WHERE week=?').get(week); return row ? { ...JSON.parse(row.body), approved: Boolean(row.approved) } : null; }
  questions() { return this.db.prepare('SELECT week FROM questions ORDER BY week').all().map(r => this.question(r.week)); }
  approve(week) {
    if (!this.question(week)) throw new Error('Question not found');
    this.db.prepare('UPDATE questions SET approved=1 WHERE week=?').run(week);
  }
  materialize(config) {
    if (!config.firstTuesday || !config.groups.length) return;
    this.transaction(() => {
      const signature = JSON.stringify([config.firstTuesday, [...config.groups].sort(), config.pollGraceMinutes, config.answerGraceMinutes]);
      const previous = this.getMeta('schedule');
      if (previous && previous !== signature) throw new Error('Schedule configuration changed after jobs were created. Pause and reconcile the database before changing dates/groups/windows.');
      const approved = this.questions().filter(q => q.approved);
      if (!approved.length) return;
      this.setMeta('schedule', signature);
      for (const q of approved) {
        const times = schedule(config.firstTuesday, q.week);
        for (const group of config.groups) for (const kind of ['poll', 'answer']) {
          const grace = kind === 'poll' ? config.pollGraceMinutes : config.answerGraceMinutes;
          this.db.prepare('INSERT OR IGNORE INTO jobs (week,group_id,kind,due,deadline) VALUES (?,?,?,?,?)').run(q.week, group, kind, times[kind], times[kind] + grace * 60_000);
        }
      }
    });
  }
  jobs() { return this.db.prepare('SELECT * FROM jobs ORDER BY due,id').all(); }
  event(id, at, event) { this.db.prepare('INSERT INTO events (job_id,at,event) VALUES (?,?,?)').run(id, at, event); }
  recover(now) {
    this.db.prepare("UPDATE jobs SET state='unknown',error='interrupted_send' WHERE state='sending' AND lease<=?").run(now);
    this.db.prepare("UPDATE jobs SET state='skipped',error='deadline_passed' WHERE state IN ('pending','retry_wait') AND deadline<?").run(now);
    this.db.exec("UPDATE jobs SET state='skipped',error='poll_not_sent' WHERE kind='answer' AND state IN ('pending','retry_wait') AND EXISTS (SELECT 1 FROM jobs p WHERE p.week=jobs.week AND p.group_id=jobs.group_id AND p.kind='poll' AND p.state='skipped')");
  }
  claim(now) {
    return this.transaction(() => {
      this.recover(now);
      const job = this.db.prepare(`SELECT j.* FROM jobs j WHERE j.state IN ('pending','retry_wait') AND j.due<=? AND j.next_attempt<=? AND j.deadline>=?
        AND (j.kind='poll' OR EXISTS (SELECT 1 FROM jobs p WHERE p.week=j.week AND p.group_id=j.group_id AND p.kind='poll' AND p.state='sent')) ORDER BY j.due,j.id LIMIT 1`).get(now, now, now);
      if (!job) return null;
      this.db.prepare("UPDATE jobs SET state='sending',attempts=attempts+1,lease=? WHERE id=?").run(now + 120_000, job.id);
      this.event(job.id, now, 'sending');
      return { ...job, attempts: job.attempts + 1 };
    });
  }
  finish(id, state, now, { messageId = null, error = null, next = 0 } = {}) {
    this.transaction(() => {
      this.db.prepare('UPDATE jobs SET state=?,message_id=?,error=?,next_attempt=?,lease=NULL WHERE id=?').run(state, messageId, error, next, id);
      this.event(id, now, state);
    });
  }
  resolve(id, action, messageId, now) {
    const job = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!job || job.state !== 'unknown') throw new Error('Only unknown jobs can be reconciled');
    if (!['sent', 'retry', 'skip'].includes(action)) throw new Error('Use sent, retry, or skip');
    if (action === 'sent' && !messageId) throw new Error('Provide the confirmed WhatsApp message ID');
    this.finish(id, { sent: 'sent', retry: 'pending', skip: 'skipped' }[action], now, { messageId, error: 'operator_reconciled' });
  }
}

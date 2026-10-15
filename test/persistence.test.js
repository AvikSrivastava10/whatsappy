import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { tuesday } from '../src/schedule.js';

const q = JSON.parse(readFileSync(new URL('../examples/question.json', import.meta.url)));
const config = { firstTuesday: '2026-10-20', groups: ['1@g.us'], pollGraceMinutes: 120, answerGraceMinutes: 1440 };

test('state survives restart and two database connections cannot claim the same job', t => {
  const dir = mkdtempSync(join(tmpdir(), 'whatsappy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'quiz.sqlite');
  let a = new Store(path); a.saveQuestion(q); a.approve(1); a.materialize(config); a.close();
  a = new Store(path); const b = new Store(path);
  try {
    const job = a.claim(tuesday(config.firstTuesday));
    assert.ok(job);
    assert.equal(b.claim(tuesday(config.firstTuesday)), null);
    b.recover(tuesday(config.firstTuesday) + 120_001);
    assert.equal(a.jobs()[0].state, 'unknown');
    assert.throws(() => a.resolve(job.id, 'sent', null, Date.now()), /message ID/);
    a.resolve(job.id, 'sent', 'confirmed-message', Date.now());
    assert.equal(b.jobs()[0].state, 'sent');
  } finally { a.close(); b.close(); }
});

test('question replacement clears approval; duplicate stems across weeks rejected', t => {
  const s = new Store(':memory:'); t.after(() => s.close());
  s.saveQuestion(q); s.approve(1); s.saveQuestion({ ...q, explanation: 'Revised explanation.' });
  assert.equal(s.question(1).approved, false);
  assert.throws(() => s.saveQuestion({ ...q, week: 2 }));
});

import { mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { customSchedule, formatIST } from './schedule.js';
import { Store } from './store.js';
import { dispatch } from './dispatcher.js';
import { loadConfig } from './config.js';

export async function promptTestSchedule(ask, now = Date.now) {
  const poll = await ask('Poll date and time in IST (YYYY-MM-DD HH:mm): ');
  const answer = await ask('Answer date and time in IST (YYYY-MM-DD HH:mm): ');
  return customSchedule(poll.trim(), answer.trim(), now());
}

export async function readTestSchedule() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const iterator = rl[Symbol.asyncIterator]();
  try {
    return await promptTestSchedule(async prompt => {
      process.stdout.write(prompt);
      const line = await iterator.next();
      if (line.done) throw new Error('Test scheduling cancelled: both date/time inputs are required');
      return line.value;
    });
  } finally { rl.close(); }
}

function settings(config) {
  return JSON.stringify([[...config.groups].sort(), config.pollGraceMinutes, config.answerGraceMinutes]);
}

export function createTestRun(templates, config, week, times, live = false, now = Date.now()) {
  if (!config.testMode) throw new Error('test-run requires a dedicated test configuration');
  const q = templates.question(week);
  if (!q?.approved) throw new Error('Preview and approve the test question before running a test');
  if (!config.groups.length) throw new Error('Configure at least one testGroups destination');
  if (!Number.isFinite(times.poll) || times.poll <= now || !Number.isFinite(times.answer) || times.answer <= times.poll) throw new Error('Test poll must be in the future and answer must follow it');
  const id = randomUUID();
  const directory = join(config.runtimeDir, 'runs', id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const store = new Store(join(directory, 'quiz.sqlite'));
  try {
    store.bindEnvironment(true);
    // Copy the exact approved template; subsequent edits cannot change this run.
    store.saveQuestion(q); store.approve(week);
    const runConfig = { ...config, liveEnabled: live, testSchedule: { week, ...times } };
    store.materialize(runConfig);
    store.setMeta('run', JSON.stringify({ id, live, settings: settings(config), schedule: runConfig.testSchedule }));
    return { id, directory, store, config: runConfig };
  } catch (error) { store.close(); throw error; }
}

export function openTestRun(config, id, live, { inspect = false } = {}) {
  if (!config.testMode || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id || '')) throw new Error('Provide a valid test run ID from test-status');
  const directory = join(config.runtimeDir, 'runs', id);
  if (!existsSync(join(directory, 'quiz.sqlite'))) throw new Error('Test run not found');
  const store = new Store(join(directory, 'quiz.sqlite'));
  try {
    store.bindEnvironment(true);
    const saved = JSON.parse(store.getMeta('run') || 'null');
    if (!saved || saved.id !== id) throw new Error('Invalid test run metadata');
    if (!inspect && saved.settings !== settings(config)) throw new Error('Test allowlist/windows changed: restore the original test settings to resume, or create a new test');
    if (live !== undefined && saved.live !== live) throw new Error('Resume requires the original live/dry-run mode; a dry-run cannot be promoted to live');
    const runConfig = { ...config, liveEnabled: saved.live, testSchedule: saved.schedule };
    if (!inspect) store.materialize(runConfig);
    return { id, directory, store, config: runConfig };
  } catch (error) { store.close(); throw error; }
}

export function listTestRuns(config) {
  const root = join(config.runtimeDir, 'runs');
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(id => /^[0-9a-f-]{36}$/.test(id)).map(id => {
    const run = openTestRun(config, id, undefined, { inspect: true });
    try { return summarizeRun(run); } finally { run.store.close(); }
  });
}

export function summarizeRun(run) {
  return { id: run.id, mode: run.config.liveEnabled ? 'live' : 'dry-run', database: join(run.directory, 'quiz.sqlite'),
    poll: formatIST(run.config.testSchedule.poll), answer: formatIST(run.config.testSchedule.answer), jobs: run.store.jobs() };
}

export async function executeTestRun(run, templates, configPath, sender, { stopped = () => false, wait = ms => new Promise(r => setTimeout(r, ms)), now = Date.now } = {}) {
  if (!run.config.liveEnabled) return; // Dry runs never even inspect a transport.
  while (!stopped()) {
    // Recheck isolation if the owner edits either configuration while a test is waiting.
    const fresh = loadConfig(configPath);
    if (!fresh.testMode || fresh.runtimeDir !== run.config.runtimeDir || settings(fresh) !== settings(run.config)) throw new Error('Test configuration changed during execution; stopped without rescheduling');
    if (templates.getMeta('paused') !== 'true') await dispatch(run.store, sender, run.config, { now });
    const jobs = run.store.jobs();
    if (jobs.some(j => j.state === 'unknown')) throw new Error('Uncertain delivery: inspect the group, use test-resolve, then test-resume. No automatic resend.');
    if (jobs.every(j => ['sent', 'skipped'].includes(j.state))) return;
    await wait(1000);
  }
}

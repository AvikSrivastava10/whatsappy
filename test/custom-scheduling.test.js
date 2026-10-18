import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, mkdirSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { customSchedule, parseIST, schedule } from '../src/schedule.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { dispatch } from '../src/dispatcher.js';
import { promptTestSchedule, createTestRun, openTestRun, executeTestRun, listTestRuns } from '../src/testing.js';

const sample = JSON.parse(readFileSync('examples/question.json', 'utf8'));
const example = JSON.parse(readFileSync('config.example.json', 'utf8'));
const testExample = JSON.parse(readFileSync('config.test.example.json', 'utf8'));
const cli = resolve('src/cli.js');
const baseTime = Date.parse('2099-01-01T00:00:00Z');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'whatsappy-custom-'));
  const resources = [];
  t.after(() => { for (const resource of resources) resource.close(); rmSync(root, { recursive: true, force: true }); });
  const prodPath = join(root, 'config.json'), testPath = join(root, 'config.test.json');
  const prod = { ...example, firstTuesday: '2026-10-20', groups: ['1@g.us', '2@g.us', '3@g.us'], runtimeDir: join(root, 'production') };
  const testing = { ...testExample, productionConfig: prodPath, testGroups: ['9@g.us'], runtimeDir: join(root, 'testing') };
  writeFileSync(prodPath, JSON.stringify(prod)); writeFileSync(testPath, JSON.stringify(testing));
  const config = loadConfig(testPath);
  return { root, prodPath, testPath, prod, testing, config, resources };
}
function templates(t) { const s = new Store(':memory:'); t.after(() => s.close()); s.bindEnvironment(true); s.saveQuestion(sample); return s; }
function times() { return customSchedule('2099-01-04 18:17', '2099-01-04 18:21', baseTime); }

test('custom IST scheduling accepts any weekday, midnight and same-day answers independent of host timezone', () => {
  assert.equal(new Date(parseIST('2026-10-18 19:43')).toISOString(), '2026-10-18T14:13:00.000Z');
  assert.equal(new Date(parseIST('2026-10-19 00:00')).toISOString(), '2026-10-18T18:30:00.000Z');
  assert.equal(times().answer - times().poll, 4 * 60_000);
  assert.equal(parseIST('2028-02-29 12:00'), Date.parse('2028-02-29T06:30:00Z'));
  assert.equal(new Date(schedule('2026-10-20', 1).poll).toISOString(), '2026-10-20T02:30:00.000Z');
  assert.equal(new Date(schedule('2026-10-20', 1).answer).toISOString(), '2026-10-21T02:30:00.000Z');
});
test('custom scheduling rejects malformed dates, impossible times, past polls and reversed/equal answers', () => {
  for (const value of ['2026-02-29 12:00', '2026-04-31 10:00', '2026-10-18 24:00', '2026-10-18 08:60', '2026-1-1 8:00', '2026-10-18T08:00Z', '']) assert.throws(() => parseIST(value));
  assert.throws(() => customSchedule('2026-10-18 12:00', '2026-10-18 13:00', baseTime), /future/);
  assert.throws(() => customSchedule('2099-01-04 18:17', '2099-01-04 18:17', baseTime), /after/);
  assert.throws(() => customSchedule('2099-01-04 18:17', '2099-01-04 18:16', baseTime), /after/);
});
test('every fresh test asks for both times and validates against time after input', async () => {
  const asked = [];
  for (let i = 0; i < 2; i++) {
    const answers = ['2099-01-04 18:17', '2099-01-04 18:21'];
    assert.deepEqual(await promptTestSchedule(async label => { asked.push(label); return answers.shift(); }, () => baseTime), times());
  }
  assert.equal(asked.length, 4);
});
test('configuration rejects shared/nested runtimes, shared config, production groups and embedded test schedules', t => {
  const f = fixture(t);
  const reject = (changes, pattern) => { writeFileSync(f.testPath, JSON.stringify({ ...f.testing, ...changes })); assert.throws(() => loadConfig(f.testPath), pattern); };
  reject({ runtimeDir: f.prod.runtimeDir }, /non-nested/);
  reject({ runtimeDir: join(f.prod.runtimeDir, 'child') }, /non-nested/);
  reject({ runtimeDir: f.root }, /non-nested/);
  reject({ productionConfig: f.testPath }, /separate files/);
  reject({ testGroups: ['1@g.us'] }, /overlaps/);
  reject({ testGroups: ['9@g.us', '9@g.us'] }, /distinct/);
  reject({ testGroups: ['someone@s.whatsapp.net'] }, /group IDs/);
  reject({ groups: ['9@g.us'] }, /testGroups/);
  reject({ firstTuesday: '2026-10-20' }, /firstTuesday=null/);
  reject({ liveEnabled: true }, /liveEnabled=false/);
  reject({ testSchedule: times() }, /interactively/);
  writeFileSync(f.prodPath, JSON.stringify({ ...f.prod, testSchedule: times() }));
  assert.throws(() => loadConfig(f.prodPath), /interactively/);
});
test('symlink runtime aliases cannot bypass isolation', t => {
  const f = fixture(t);
  const alias = join(f.root, 'alias');
  // Existing root as a junction works without Windows symlink privileges.
  symlinkSync(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(f.testPath, JSON.stringify({ ...f.testing, runtimeDir: join(alias, 'production') }));
  assert.throws(() => loadConfig(f.testPath), /non-nested/);
});
test('hard-linked database inside a separate test runtime is rejected before opening it', t => {
  const f = fixture(t);
  mkdirSync(f.config.runtimeDir);
  const protectedFile = join(f.root, 'protected.sqlite');
  writeFileSync(protectedFile, 'protected bytes');
  linkSync(protectedFile, join(f.config.runtimeDir, 'quiz.sqlite'));
  assert.throws(() => loadConfig(f.testPath), /hard-linked/);
  assert.equal(readFileSync(protectedFile, 'utf8'), 'protected bytes');
});
test('approved test snapshots create independent immutable databases; production bytes and jobs unchanged', t => {
  const f = fixture(t); const s = templates(t);
  const production = new Store(join(f.root, 'production.sqlite')); f.resources.push(production);
  production.saveQuestion(sample); production.approve(1); production.materialize(f.prod);
  const before = JSON.stringify(production.jobs()), configBefore = readFileSync(f.prodPath);
  assert.throws(() => createTestRun(s, f.config, 1, times(), false, baseTime), /approve/);
  s.approve(1);
  const a = createTestRun(s, f.config, 1, times(), false, baseTime); f.resources.push(a.store);
  const b = createTestRun(s, f.config, 1, { poll: times().poll + 60_000, answer: times().answer + 60_000 }, false, baseTime); f.resources.push(b.store);
  assert.notEqual(a.directory, b.directory);
  assert.equal(a.store.jobs().length, 2);
  assert.equal(a.store.jobs()[0].due, times().poll);
  assert.ok(a.store.jobs().every(j => j.group_id === '9@g.us'));
  assert.throws(() => a.store.materialize({ ...a.config, testSchedule: b.config.testSchedule }), /immutable/);
  assert.throws(() => a.store.bindEnvironment(false), /mismatch/);
  assert.throws(() => production.materialize({ ...f.prod, testSchedule: times() }), /forbidden/);
  assert.throws(() => openTestRun({ ...f.config, groups: ['8@g.us'] }, a.id), /allowlist/);
  assert.equal(listTestRuns({ ...f.config, groups: ['8@g.us'] }).length, 2);
  assert.equal(JSON.stringify(production.jobs()), before);
  assert.deepEqual(readFileSync(f.prodPath), configBefore);
  s.saveQuestion({ ...sample, explanation: 'Revised draft needs approval again.' });
  assert.equal(a.store.question(1).explanation, sample.explanation);
  assert.throws(() => createTestRun(s, f.config, 1, times(), false, baseTime), /approve/);
});
test('mock custom delivery preserves answer dependencies, uncertain outcomes, pause and immutable recovery', async t => {
  const f = fixture(t), s = templates(t); s.approve(1);
  const a = createTestRun(s, f.config, 1, times(), true, baseTime);
  const id = a.id;
  const sent = [];
  const sender = { ready: () => true, send: async (group, payload) => { sent.push({ group, payload }); return `msg-${sent.length}`; } };
  await dispatch(a.store, sender, a.config, { now: () => times().poll - 1 });
  assert.equal(sent.length, 0);
  a.store.setMeta('paused', true);
  await dispatch(a.store, sender, a.config, { now: () => times().poll }); assert.equal(sent.length, 0);
  a.store.setMeta('paused', false);
  await dispatch(a.store, sender, a.config, { now: () => times().poll }); assert.equal(sent.length, 1);
  a.store.close();
  const resumed = openTestRun(f.config, id, true); f.resources.push(resumed.store);
  await dispatch(resumed.store, sender, resumed.config, { now: () => times().answer });
  await dispatch(resumed.store, sender, resumed.config, { now: () => times().answer + 1000 });
  assert.equal(sent.length, 2);
  assert.ok(sent[0].payload.poll); assert.ok(sent[1].payload.text);
  const uncertain = createTestRun(s, f.config, 1, times(), true, baseTime); f.resources.push(uncertain.store);
  await dispatch(uncertain.store, { ready: () => true, send: async () => { throw new Error('timeout'); } }, uncertain.config, { now: () => times().poll });
  await dispatch(uncertain.store, sender, uncertain.config, { now: () => times().answer });
  assert.equal(sent.length, 2);
  assert.equal(uncertain.store.jobs()[0].state, 'unknown');
  const dry = createTestRun(s, f.config, 1, times(), false, baseTime); f.resources.push(dry.store);
  assert.throws(() => openTestRun(f.config, dry.id, true), /cannot be promoted/);
  await executeTestRun(dry, s, f.testPath, { ready() { throw new Error('must not touch transport'); } });
});
test('runtime production allowlist changes stop test dispatch before any message', async t => {
  const f = fixture(t), s = templates(t); s.approve(1);
  const run = createTestRun(s, f.config, 1, times(), true, baseTime); f.resources.push(run.store);
  writeFileSync(f.prodPath, JSON.stringify({ ...f.prod, groups: ['9@g.us'] }));
  await assert.rejects(executeTestRun(run, s, f.testPath, { ready() { throw new Error('must not inspect sender'); } }), /overlaps/);
});
test('test poll expires at answer time and cannot trigger an answer without a poll', async t => {
  const f = fixture(t), s = templates(t); s.approve(1);
  const run = createTestRun(s, f.config, 1, times(), true, baseTime); f.resources.push(run.store);
  const sender = { ready: () => true, send: async () => { assert.fail('Expired poll must not transmit'); } };
  await dispatch(run.store, sender, run.config, { now: () => times().answer });
  assert.ok(run.store.jobs().every(j => j.state === 'skipped'));
});
test('test execution waits for custom times, respects the test pause and completes with a mock', async t => {
  const f = fixture(t), s = templates(t); s.approve(1);
  const run = createTestRun(s, f.config, 1, times(), true, baseTime); f.resources.push(run.store);
  let time = times().poll, calls = 0, waits = 0;
  s.setMeta('paused', true);
  await executeTestRun(run, s, f.testPath, { ready: () => true, send: async () => `fake-${++calls}` }, {
    now: () => time,
    wait: async () => { waits++; assert.ok(waits < 4); if (waits === 1) { assert.equal(calls, 0); s.setMeta('paused', false); } else time = times().answer; }
  });
  assert.equal(calls, 2);
  assert.ok(run.store.jobs().every(j => j.state === 'sent'));
});
test('CLI asks for fresh times, creates repeatable dry runs and never links WhatsApp', t => {
  const f = fixture(t);
  const invoke = (args, input) => spawnSync(process.execPath, [cli, ...args, '--config', f.testPath], { cwd: f.root, input, encoding: 'utf8', timeout: 10000 });
  for (const args of [['import', resolve('examples/question.json')], ['approve', '1']]) {
    const r = invoke(args); assert.equal(r.status, 0, r.stderr);
  }
  for (let i = 0; i < 2; i++) {
    const result = invoke(['test-run', '1'], '2099-01-04 18:17\n2099-01-04 18:21\n');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Poll date and time in IST/);
    assert.match(result.stdout, /Answer date and time in IST/);
    assert.match(result.stdout, /No WhatsApp connection/);
  }
  const statuses = invoke(['test-status']); assert.equal(statuses.status, 0, statuses.stderr);
  assert.equal(JSON.parse(statuses.stdout).length, 2);
  assert.ok(!existsSync(join(f.config.runtimeDir, 'auth')));
  assert.ok(!existsSync(f.prod.runtimeDir));
  assert.notEqual(invoke(['run']).status, 0);
  assert.notEqual(invoke(['test-run', '1'], '').status, 0);
  assert.notEqual(invoke(['test-run', '1'], '2099-01-04 18:17\n2099-01-04 18:16\n').status, 0);
});

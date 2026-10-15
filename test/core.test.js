import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store } from '../src/store.js';
import { schedule, tuesday, DAY } from '../src/schedule.js';
import { pollPayload, validateQuestion } from '../src/content.js';
import { dispatch } from '../src/dispatcher.js';

const question = JSON.parse(readFileSync(new URL('../examples/question.json', import.meta.url)));
const config = { firstTuesday: '2026-10-20', groups: ['1@g.us', '2@g.us', '3@g.us'], pollGraceMinutes: 120, answerGraceMinutes: 1440, liveEnabled: true };
function fixture(t) { const s = new Store(':memory:'); t.after(() => s.close()); s.saveQuestion(question); s.approve(1); s.materialize(config); return s; }

test('IST calendar schedule is fixed regardless of host timezone', () => {
  const s = schedule(config.firstTuesday, 1);
  assert.equal(new Date(s.poll).toISOString(), '2026-10-20T02:30:00.000Z');
  assert.equal(s.answer - s.poll, DAY);
  assert.equal(schedule(config.firstTuesday, 2).poll - s.poll, 7 * DAY);
  assert.throws(() => tuesday('2026-02-31'));
  assert.throws(() => tuesday('2026-10-21'));
});
test('poll excludes answer and rejects duplicate options', () => {
  const p = pollPayload(validateQuestion(question));
  assert.equal(p.poll.selectableCount, 1);
  assert.equal(p.poll.values.length, 4);
  assert.ok(!JSON.stringify(p).includes(question.explanation));
  assert.throws(() => validateQuestion({ ...question, options: ['A', ' a ', 'B', 'C'] }));
});
test('repeated scheduling creates six jobs; scheduled content is frozen', t => {
  const s = fixture(t); s.materialize(config);
  assert.equal(s.jobs().length, 6);
  assert.throws(() => s.saveQuestion(question), /immutable/);
  assert.throws(() => s.materialize({ ...config, firstTuesday: '2026-10-27' }), /changed/);
});
test('partial sends do not duplicate successes and answers depend on same group poll', async t => {
  const s = fixture(t); const sent = [];
  const sender = { ready: () => true, send: async (id, body) => { if (id === '2@g.us') throw new Error('ambiguous'); sent.push([id, body]); return `message-${sent.length}`; } };
  const poll = tuesday(config.firstTuesday);
  await dispatch(s, sender, config, { now: () => poll });
  await dispatch(s, sender, config, { now: () => poll + 1000 });
  assert.equal(sent.length, 2);
  assert.equal(s.jobs().filter(j => j.state === 'unknown').length, 1);
  await dispatch(s, sender, config, { now: () => poll + DAY });
  assert.equal(sent.length, 4);
  assert.ok(sent[2][1].text.includes('B — Overfitting'));
});
test('crashed send becomes unknown; late unattempted polls are skipped', t => {
  const s = fixture(t); const poll = tuesday(config.firstTuesday);
  const claimed = s.claim(poll);
  s.recover(poll + 3 * 60 * 60_000);
  assert.equal(s.jobs().find(j => j.id === claimed.id).state, 'unknown');
  assert.equal(s.jobs().filter(j => j.state === 'skipped').length, 4);
});
test('dry-run does not send or change delivery status', async t => {
  const s = fixture(t);
  await dispatch(s, { ready() { throw new Error('must not connect'); } }, { ...config, liveEnabled: false });
  assert.ok(s.jobs().every(j => j.state === 'pending'));
});
test('safe pre-send failure retries and respects pause', async t => {
  const s = fixture(t); const poll = tuesday(config.firstTuesday); let calls = 0;
  const sender = { ready: () => true, send: async () => { calls++; throw Object.assign(new Error('offline'), { safeToRetry: true }); } };
  await dispatch(s, sender, config, { now: () => poll, random: () => 0 });
  assert.equal(calls, 3);
  assert.ok(s.jobs().filter(j => j.kind === 'poll').every(j => j.state === 'retry_wait'));
  s.setMeta('paused', true);
  await dispatch(s, sender, config, { now: () => poll + 60_000 });
  assert.equal(calls, 3);
});

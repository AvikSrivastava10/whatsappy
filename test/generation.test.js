import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateQuestion } from '../src/gemini.js';
import { prepare } from '../src/prepare.js';
import { Store } from '../src/store.js';
import { tuesday, DAY } from '../src/schedule.js';

const sample = JSON.parse(readFileSync(new URL('../examples/question.json', import.meta.url)));
const config = { firstTuesday: '2026-10-20', autoGenerate: true, generationLeadDays: 3, pollGraceMinutes: 120, language: 'English', geminiModel: 'test-model' };

test('Gemini request uses structured output, header key and only question history', async () => {
  const result = await generateQuestion(config, 2, [{ ...sample, secret: 'must-not-leak' }], {
    apiKey: 'test-key', fetchImpl: async (url, request) => {
      assert.ok(!url.includes('test-key'));
      assert.equal(request.headers['x-goog-api-key'], 'test-key');
      const body = JSON.parse(request.body);
      assert.equal(body.generationConfig.responseMimeType, 'application/json');
      assert.ok(!request.body.includes('must-not-leak'));
      return { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(sample) }] } }] }) };
    }
  });
  assert.equal(result.week, 2);
});
test('Gemini rejects quota errors, incomplete responses and malformed candidates', async () => {
  await assert.rejects(generateQuestion(config, 1, [], { apiKey: 'key', fetchImpl: async () => ({ ok: false, status: 429 }) }), /429/);
  await assert.rejects(generateQuestion(config, 1, [], { apiKey: 'key', fetchImpl: async () => ({ ok: true, json: async () => ({ candidates: [{ finishReason: 'MAX_TOKENS' }] }) }) }), /complete/);
  await assert.rejects(generateQuestion(config, 1, [], { apiKey: 'key', fetchImpl: async () => ({ ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{}' }] } }] }) }) }), /Invalid topic/);
});
test('automatic preparation saves only a draft and does not regenerate it', async t => {
  const s = new Store(':memory:'); t.after(() => s.close()); let calls = 0;
  const now = tuesday(config.firstTuesday) - DAY;
  const generate = async () => { calls++; return sample; };
  await prepare(s, config, { now, generate });
  await prepare(s, config, { now: now + 1000, generate });
  assert.equal(calls, 1);
  assert.equal(s.question(1).approved, false);
  assert.equal(s.jobs().length, 0);
});
test('generation errors throttle subsequent requests durably', async t => {
  const s = new Store(':memory:'); t.after(() => s.close()); let calls = 0;
  const now = tuesday(config.firstTuesday) - DAY;
  const generate = async () => { calls++; throw new Error('quota'); };
  await assert.rejects(prepare(s, config, { now, generate }), /quota/);
  await prepare(s, config, { now: now + 60_000, generate });
  assert.equal(calls, 1);
});
test('automatic generation cannot overwrite a concurrently imported question', async t => {
  const s = new Store(':memory:'); t.after(() => s.close());
  await assert.rejects(prepare(s, config, {
    now: tuesday(config.firstTuesday) - DAY,
    generate: async () => { s.saveQuestion(sample); return { ...sample, question: 'Replacement?' }; }
  }), /already exists/);
  assert.equal(s.question(1).question, sample.question);
});

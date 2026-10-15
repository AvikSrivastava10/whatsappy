import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWAMessageContent } from '@whiskeysockets/baileys';
import { readFileSync } from 'node:fs';
import { pollPayload } from '../src/content.js';
import { WhatsApp } from '../src/whatsapp.js';

test('pinned Baileys encodes our payload as a native single-choice poll without network', async () => {
  const q = JSON.parse(readFileSync(new URL('../examples/question.json', import.meta.url)));
  const message = await generateWAMessageContent(pollPayload(q), {});
  const poll = message.pollCreationMessageV3;
  assert.ok(poll);
  assert.equal(poll.selectableOptionsCount, 1);
  assert.equal(poll.options.length, 4);
  assert.equal(poll.options[1].optionName, 'B. Overfitting');
  assert.ok(!JSON.stringify(poll).includes(q.explanation));
});
test('disconnected adapter proves no transmission; socket error stays ambiguous', async () => {
  const wa = new WhatsApp('unused');
  await assert.rejects(wa.send('1@g.us', { text: 'test' }), e => e.safeToRetry === true);
  wa.connected = true;
  wa.socket = { sendMessage: async () => { throw new Error('socket timeout'); } };
  await assert.rejects(wa.send('1@g.us', { text: 'test' }), e => !e.safeToRetry);
});

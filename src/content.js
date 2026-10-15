import { createHash } from 'node:crypto';

export function validateQuestion(input) {
  if (!input || typeof input !== 'object') throw new Error('Question must be an object');
  if (!Number.isInteger(input.week) || input.week < 1 || input.week > 520) throw new Error('week must be 1..520');
  const q = { week: input.week };
  for (const [key, max] of [['topic', 100], ['question', 700], ['explanation', 1800]]) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > max) throw new Error(`Invalid ${key} (maximum ${max} characters)`);
    q[key] = input[key].trim();
  }
  if (!Array.isArray(input.options) || input.options.length !== 4 || input.options.some(x => typeof x !== 'string' || !x.trim() || x.length > 95)) throw new Error('Provide four nonempty options, each at most 95 characters');
  q.options = input.options.map(x => x.trim());
  if (new Set(q.options.map(normalize)).size !== 4) throw new Error('Options must be unique');
  if (!Number.isInteger(input.correctOptionIndex) || input.correctOptionIndex < 0 || input.correctOptionIndex > 3) throw new Error('correctOptionIndex must be 0..3');
  q.correctOptionIndex = input.correctOptionIndex;
  return q;
}

function normalize(text) { return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(); }
export function contentHash(q) { return createHash('sha256').update(normalize(q.question)).digest('hex'); }
export function pollPayload(q) {
  return { poll: { name: `Week ${q.week} · ${q.topic}\n${q.question}`, values: q.options.map((o, i) => `${'ABCD'[i]}. ${o}`), selectableCount: 1 } };
}
export function answerPayload(q, late = false) {
  return { text: `${late ? '(Delayed answer)\n' : ''}Week ${q.week} answer: ${'ABCD'[q.correctOptionIndex]} — ${q.options[q.correctOptionIndex]}\n\n${q.explanation}` };
}

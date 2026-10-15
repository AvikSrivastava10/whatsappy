import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { tuesday } from './schedule.js';

export function loadConfig(path = 'config.json') {
  if (existsSync('.env')) loadEnvFile('.env');
  const c = JSON.parse(readFileSync(path, 'utf8'));
  if (c.firstTuesday !== null) tuesday(c.firstTuesday);
  if (!Array.isArray(c.groups) || c.groups.some(g => typeof g !== 'string' || !/^\d+(?:-\d+)?@g\.us$/.test(g)) || new Set(c.groups).size !== c.groups.length) {
    throw new Error('groups must contain distinct WhatsApp group IDs ending in @g.us');
  }
  for (const field of ['liveEnabled', 'autoApprove', 'autoGenerate']) {
    if (typeof c[field] !== 'boolean') throw new Error(`${field} must be boolean`);
  }
  for (const field of ['pollGraceMinutes', 'answerGraceMinutes']) {
    if (!Number.isInteger(c[field]) || c[field] < 1 || c[field] > 2880) throw new Error(`${field} must be 1..2880`);
  }
  if (!Number.isInteger(c.generationLeadDays) || c.generationLeadDays < 1 || c.generationLeadDays > 6) throw new Error('generationLeadDays must be 1..6');
  if (typeof c.language !== 'string' || !c.language.trim()) throw new Error('language is required');
  if (typeof c.geminiModel !== 'string' || (c.geminiModel && !/^[a-zA-Z0-9._-]+$/.test(c.geminiModel))) throw new Error('Invalid Gemini model ID');
  if (typeof c.runtimeDir !== 'string' || !c.runtimeDir.trim()) throw new Error('runtimeDir is required');
  if (c.liveEnabled && (!c.firstTuesday || c.groups.length !== 3)) throw new Error('Live mode requires a first Tuesday and exactly three groups');
  return { ...c, runtimeDir: resolve(c.runtimeDir) };
}

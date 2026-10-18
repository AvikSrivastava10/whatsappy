import { readFileSync, existsSync, realpathSync, lstatSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename, relative, isAbsolute, join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { tuesday } from './schedule.js';

export function loadConfig(path = 'config.json') {
  if (existsSync('.env')) loadEnvFile('.env');
  const c = JSON.parse(readFileSync(path, 'utf8'));
  if (c.testSchedule !== undefined) throw new Error('Test times must be entered interactively with test-run, not stored in configuration');
  if (c.testMode) {
    if (c.firstTuesday !== null || c.autoGenerate !== false || c.liveEnabled !== false) {
      throw new Error('Test configuration requires firstTuesday=null, autoGenerate=false and liveEnabled=false. Use test-run --live explicitly.');
    }
    if ('groups' in c) throw new Error('Test configuration must use its own testGroups allowlist, not groups');
    c.groups = c.testGroups;
  }
  if (c.firstTuesday !== null) tuesday(c.firstTuesday);
  if (!Array.isArray(c.groups) || c.groups.some(g => typeof g !== 'string' || !/^\d+(?:-\d+)?@g\.us$/.test(g)) || new Set(c.groups).size !== c.groups.length) {
    throw new Error('groups must contain distinct WhatsApp group IDs ending in @g.us');
  }
  for (const field of ['liveEnabled', 'testMode', 'autoGenerate']) {
    if (typeof c[field] !== 'boolean') throw new Error(`${field} must be boolean`);
  }
  for (const field of ['pollGraceMinutes', 'answerGraceMinutes']) {
    if (!Number.isInteger(c[field]) || c[field] < 1 || c[field] > 2880) throw new Error(`${field} must be 1..2880`);
  }
  if (!Number.isInteger(c.generationLeadDays) || c.generationLeadDays < 1 || c.generationLeadDays > 6) throw new Error('generationLeadDays must be 1..6');
  if (typeof c.language !== 'string' || !c.language.trim()) throw new Error('language is required');
  if (typeof c.geminiModel !== 'string' || (c.geminiModel && !/^[a-zA-Z0-9._-]+$/.test(c.geminiModel))) throw new Error('Invalid Gemini model ID');
  if (typeof c.runtimeDir !== 'string' || !c.runtimeDir.trim()) throw new Error('runtimeDir is required');
  if (c.autoApprove === true) throw new Error('Automatic approval is unsupported: each question requires your review');
  if (c.liveEnabled && (!c.firstTuesday || c.groups.length !== 3)) throw new Error('Live mode requires a first Tuesday and exactly three groups');
  // Preserve the existing project-working-directory semantics for production.
  const runtimeDir = resolve(c.runtimeDir);
  if (c.testMode) {
    if (typeof c.productionConfig !== 'string' || !c.productionConfig) throw new Error('Test configuration must name productionConfig for isolation checks');
    const productionPath = resolve(dirname(resolve(path)), c.productionConfig);
    if (canonical(path) === canonical(productionPath)) throw new Error('Test and production configuration must be separate files');
    const production = JSON.parse(readFileSync(productionPath, 'utf8'));
    if (production.testMode !== false || typeof production.runtimeDir !== 'string' || !production.runtimeDir.trim() || !Array.isArray(production.groups)) {
      throw new Error('productionConfig must refer to a valid production configuration');
    }
    const productionRuntime = resolve(production.runtimeDir);
    if (overlap(runtimeDir, productionRuntime)) throw new Error('Test and production runtime directories must be separate and non-nested (including symlinks)');
    if (overlap(path, productionRuntime)) throw new Error('Test configuration cannot be inside production runtime');
    if (overlap(productionPath, runtimeDir) || overlap(path, runtimeDir)) throw new Error('Configuration files must be outside the test runtime directory');
    if (c.groups.some(g => production.groups.includes(g))) throw new Error('Test group allowlist overlaps production groups');
    assertPrivateTree(runtimeDir);
  }
  return { ...c, runtimeDir };
}

function assertPrivateTree(path) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error('Test runtime must not contain symlinks or hard-linked files');
  if (stat.isDirectory()) for (const name of readdirSync(path)) assertPrivateTree(join(path, name));
}

// Resolve existing ancestors too: a not-yet-created directory can sit under a symlink.
function canonical(path) {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  return resolve(canonical(dirname(absolute)), basename(absolute));
}
function overlap(a, b) {
  const left = canonical(a), right = canonical(b);
  const contains = (parent, child) => { const r = relative(parent, child); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
  return contains(left, right) || contains(right, left);
}

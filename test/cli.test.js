import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = resolve('src/cli.js');
const example = resolve('examples/question.json');
test('CLI imports, previews, approves, backs up and keeps configuration private', t => {
  const dir = mkdtempSync(join(tmpdir(), 'whatsappy-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = JSON.parse(readFileSync('config.example.json', 'utf8'));
  config.runtimeDir = join(dir, 'runtime');
  config.firstTuesday = '2026-10-20'; config.groups = ['1@g.us', '2@g.us', '3@g.us'];
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  const run = (...args) => {
    const r = spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, WHATSAPPY_CONFIG: join(dir, 'config.json') } });
    assert.equal(r.status, 0, r.stderr); return r.stdout;
  };
  run('doctor'); run('import', example);
  assert.equal(JSON.parse(run('preview', '1')).approved, false);
  run('approve', '1');
  let status = JSON.parse(run('status'));
  assert.equal(status.jobs.length, 6);
  assert.equal(status.mode, 'dry-run');
  run('pause'); assert.equal(JSON.parse(run('status')).paused, true);
  run('resume'); assert.equal(JSON.parse(run('status')).paused, false);
  run('backup');
  assert.equal(readdirSync(join(config.runtimeDir, 'backups')).length, 1);
  assert.ok(!existsSync(join(config.runtimeDir, 'auth')));
});

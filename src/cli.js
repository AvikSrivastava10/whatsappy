import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { pollPayload, answerPayload } from './content.js';
import { dispatch } from './dispatcher.js';
import { generateQuestion } from './gemini.js';
import { prepare } from './prepare.js';
import { readTestSchedule, createTestRun, openTestRun, listTestRuns, summarizeRun, executeTestRun } from './testing.js';

const help = `Whatsappy — Tuesday polls / Wednesday answers at 08:00 IST
Commands (npm run bot -- COMMAND):
  init                     Create local config.json and .env (never overwrite)
  test-init                Create config.test.json (never overwrite production)
  test-run WEEK [--live]    Ask for poll/answer IST times; dry-run by default
  test-resume ID [--live]   Recover an existing run with its original times/mode
  test-status              List isolated test runs and delivery jobs
  test-resolve RUN ID sent MSG_ID | retry | skip
                           Reconcile an uncertain test delivery after inspection
  doctor                   Check runtime, configuration and SQLite
  import FILE              Import a question JSON (review required)
  generate WEEK            Generate a draft with Gemini
  preview WEEK             Show poll and answer without connecting to WhatsApp
  approve WEEK             Approve the stored draft and create scheduled jobs
  status                   Show questions, jobs, and connection state
  pause | resume           Persistently pause/resume dispatch and generation
  resolve ID sent MSG_ID    Mark an unknown send confirmed after manual inspection
  resolve ID retry          Retry an unknown send ONLY after confirming it was not sent
  resolve ID skip           Skip an unknown send
  link [PHONE]             Link WhatsApp by QR, or numeric international phone code
  groups                   List group IDs from the linked account
  run                      Run scheduler (dry-run unless liveEnabled is true)
  backup                   Create a consistent database backup under runtime/backups

Config path: WHATSAPPY_CONFIG environment variable (default config.json).
Use --config FILE to select explicitly; test-* defaults to config.test.json.
Stop the service before link/groups. No command sends an immediate test message.`;

async function main() {
  process.umask(0o077);
  const argv = process.argv.slice(2);
  const configIndex = argv.indexOf('--config');
  let explicitConfig;
  if (configIndex !== -1) {
    explicitConfig = argv[configIndex + 1];
    if (!explicitConfig || explicitConfig.startsWith('--')) throw new Error('--config requires a filename');
    argv.splice(configIndex, 2);
  }
  const [command = 'help', ...args] = argv;
  if (command === 'help' || command === '--help') { console.log(help); return; }
  if (command === 'init') {
    if (explicitConfig) throw new Error('init creates config.json; use test-init for the dedicated test configuration');
    for (const [source, dest] of [['config.example.json', 'config.json'], ['.env.example', '.env']]) {
      if (!existsSync(dest)) copyFileSync(source, dest);
    }
    console.log('Local config.json and .env are ready. Edit them before live operation.'); return;
  }
  if (command === 'test-init') {
    if (explicitConfig) throw new Error('test-init creates config.test.json; edit its productionConfig path afterward if needed');
    if (!existsSync('config.test.json')) copyFileSync('config.test.example.json', 'config.test.json');
    console.log('config.test.json ready. Configure testGroups; production settings were not changed.'); return;
  }
  const configPath = explicitConfig || (command.startsWith('test-') ? 'config.test.json' : process.env.WHATSAPPY_CONFIG || 'config.json');
  const config = loadConfig(configPath);
  if (command.startsWith('test-') && !config.testMode) throw new Error('Test commands require a dedicated test configuration');
  if (command === 'run' && config.testMode) throw new Error('Use test-run WEEK: every new test requires fresh interactive IST times');
  mkdirSync(config.runtimeDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(config.runtimeDir, 0o700);
  const store = new Store(join(config.runtimeDir, 'quiz.sqlite'));
  let release, wa;
  try {
    store.bindEnvironment(config.testMode);
    const week = () => { const n = Number(args[0]); if (!Number.isInteger(n) || n < 1 || n > 520) throw new Error('Provide week 1..520'); return n; };
    const statusPath = join(config.runtimeDir, 'connection.json');
    const report = event => {
      writeFileSync(statusPath, JSON.stringify({ event, at: new Date().toISOString() }) + '\n');
      console.log(JSON.stringify({ event, at: new Date().toISOString() }));
    };
    switch (command) {
      case 'test-status': console.log(JSON.stringify(listTestRuns(config), null, 2)); break;
      case 'test-resolve': {
        const run = openTestRun(config, args[0], undefined, { inspect: true });
        try { run.store.resolve(Number(args[1]), args[2], args[3] || null, Date.now()); }
        finally { run.store.close(); }
        console.log('Test reconciliation recorded.'); break;
      }
      case 'test-run': case 'test-resume': {
        if (args.slice(1).some(arg => arg !== '--live') || args.filter(arg => arg === '--live').length > 1) throw new Error('Use test-run WEEK [--live] or test-resume ID [--live]');
        const live = args.includes('--live');
        release = await lockfile.lock(config.runtimeDir, { stale: 180_000, update: 10_000, retries: 0 });
        let run;
        if (command === 'test-run') {
          const w = week();
          if (!store.question(w)?.approved) throw new Error('Preview and approve the test question before running a test');
          if (!config.groups.length) throw new Error('Configure testGroups before running a test');
          const times = await readTestSchedule();
          run = createTestRun(store, config, w, times, live);
        } else run = openTestRun(config, args[0], live);
        try {
          console.log(JSON.stringify(summarizeRun(run), null, 2));
          if (!live) { console.log('Dry-run saved. No WhatsApp connection or messages. Run test-run again with --live and enter fresh times when ready.'); break; }
          const { WhatsApp } = await import('./whatsapp.js');
          wa = new WhatsApp(join(config.runtimeDir, 'auth'), { report });
          await wa.start();
          let stopping = false;
          const stop = () => { stopping = true; };
          process.once('SIGINT', stop); process.once('SIGTERM', stop);
          try { await executeTestRun(run, store, configPath, wa, { stopped: () => stopping }); }
          finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
          console.log(JSON.stringify(summarizeRun(run), null, 2));
        } finally { run.store.close(); }
        break;
      }
      case 'doctor':
        console.log(JSON.stringify({ node: process.version, platform: process.platform, sqlite: 'available',
          mode: config.liveEnabled ? 'live' : 'dry-run', groups: config.groups.length,
          firstTuesday: config.firstTuesday, apiKeyPresent: Boolean(process.env.GEMINI_API_KEY),
          model: config.geminiModel || 'not selected', linked: existsSync(join(config.runtimeDir, 'auth', 'creds.json')),
          note: 'Android background survival and real network sends require on-device tests.' }, null, 2)); break;
      case 'import':
        console.log(`Draft week ${store.saveQuestion(JSON.parse(readFileSync(args[0], 'utf8'))).week} saved. Preview before approval.`); break;
      case 'generate': {
        const w = week();
        if (store.question(w)) throw new Error('A question already exists for this week; review or import a replacement draft');
        store.saveQuestion(await generateQuestion(config, w, store.questions()), { replace: false });
        console.log(`Draft week ${w} saved. Preview before approval.`); break;
      }
      case 'preview': {
        const q = store.question(week()); if (!q) throw new Error('Question not found');
        console.log(JSON.stringify({ approved: q.approved, poll: pollPayload(q), answer: answerPayload(q) }, null, 2)); break;
      }
      case 'approve': store.approve(week()); store.materialize(config); console.log(config.testMode ? 'Test template approved. Use test-run to enter times and create an isolated run.' : 'Approved. Jobs scheduled when a start date and groups are configured.'); break;
      case 'status':
        console.log(JSON.stringify({ mode: config.liveEnabled ? 'live' : 'dry-run', paused: store.getMeta('paused') === 'true',
          questions: store.questions().map(q => ({ week: q.week, topic: q.topic, approved: q.approved })), jobs: store.jobs(),
          connection: existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, 'utf8')) : null }, null, 2)); break;
      case 'pause': case 'resume': store.setMeta('paused', command === 'pause'); console.log(command === 'pause' ? 'Paused.' : 'Resumed.'); break;
      case 'resolve':
        store.resolve(Number(args[0]), args[1], args[2] || null, Date.now()); console.log('Reconciliation recorded.'); break;
      case 'backup': {
        const directory = join(config.runtimeDir, 'backups'); mkdirSync(directory, { recursive: true });
        const target = join(directory, `${Date.now()}.sqlite`);
        store.db.prepare('VACUUM INTO ?').run(target); console.log(`Database backup: ${target}`); break;
      }
      case 'link': case 'groups': case 'run': {
        release = await lockfile.lock(config.runtimeDir, { stale: 180_000, update: 10_000, retries: 0 });
        if (command !== 'run' || config.liveEnabled) {
          if (command === 'link' && args[0] && !/^\d{8,15}$/.test(args[0])) throw new Error('Phone must contain 8–15 digits, including country code; omit +');
          const { WhatsApp } = await import('./whatsapp.js');
          wa = new WhatsApp(join(config.runtimeDir, 'auth'), { interactive: command === 'link', phone: args[0], report });
          await wa.start();
        }
        if (command === 'groups') { console.log(JSON.stringify(await wa.groups(), null, 2)); break; }
        if (command === 'link') {
          await wa.waitReady();
          // Allow the final credentials event to flush before disconnecting.
          await new Promise(r => setTimeout(r, 2000));
          console.log('Linked. Use groups to find your three destination IDs.'); break;
        }
        console.log(config.liveEnabled ? 'Live scheduler running. Ctrl+C to stop.' : 'Dry-run scheduler: no WhatsApp connection or messages. Ctrl+C to stop.');
        let stopping = false;
        const stop = () => { stopping = true; };
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
        try {
          while (!stopping) {
            try {
              // Dispatch first; a slow generation request must not delay already prepared jobs.
              store.materialize(config);
              if (config.liveEnabled) await dispatch(store, wa, config);
              try {
                const created = await prepare(store, config);
                for (const w of created) console.log(JSON.stringify({ event: 'draft_ready_review_required', week: w }));
              } catch { console.log(JSON.stringify({ event: 'generation_failed', action: 'Check Gemini key, model, quota, or candidate validity. Automatic retry in six hours.' })); }
            } catch { report('cycle_failed_check_config_quota_or_database'); }
            for (let i = 0; i < 30 && !stopping; i++) await new Promise(r => setTimeout(r, 1000));
          }
        } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
        break;
      }
      default: throw new Error(`Unknown command: ${command}. Run help.`);
    }
  } finally { wa?.stop(); await wa?.flush(); if (release) await release(); store.close(); }
}

main().catch(error => {
  // Do not print provider responses, headers, stack traces, or raw WhatsApp errors.
  if (error.code === 'ELOCKED') console.error('Another Whatsappy connection/service is running. Stop it first.');
  else console.error(error.message?.includes('SQLITE_CONSTRAINT') ? 'Duplicate question or conflicting database record.' : error.message);
  process.exitCode = 1;
});

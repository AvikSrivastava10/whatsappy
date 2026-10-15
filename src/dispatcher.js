import { pollPayload, answerPayload } from './content.js';

export async function dispatch(store, sender, config, { now = Date.now, random = Math.random } = {}) {
  if (!config.liveEnabled || store.getMeta('paused') === 'true') return;
  store.materialize(config);
  // Never claim while disconnected: there has been no remote send to reconcile.
  if (!sender.ready()) { store.recover(now()); return; }
  for (let count = 0; count < 100; count++) {
    if (store.getMeta('paused') === 'true' || !sender.ready()) break;
    const job = store.claim(now());
    if (!job) break;
    if (!config.groups.includes(job.group_id)) {
      store.finish(job.id, 'skipped', now(), { error: 'not_allowlisted' });
      continue;
    }
    const q = store.question(job.week);
    const payload = job.kind === 'poll' ? pollPayload(q) : answerPayload(q, now() > job.due + 60_000);
    try {
      const messageId = await sender.send(job.group_id, payload);
      if (!messageId) throw new Error('Missing send confirmation');
      store.finish(job.id, 'sent', now(), { messageId });
    } catch (e) {
      // Only failures proven to precede transmission can be retried automatically.
      if (e.safeToRetry === true) {
        const delay = Math.min(15 * 60_000, 15_000 * 2 ** Math.min(job.attempts, 6)) + Math.floor(random() * 5000);
        store.finish(job.id, 'retry_wait', now(), { error: 'not_transmitted', next: now() + delay });
      } else {
        store.finish(job.id, 'unknown', now(), { error: 'send_outcome_unknown' });
      }
    }
  }
}

import { currentWeek, schedule, DAY } from './schedule.js';
import { generateQuestion } from './gemini.js';

export async function prepare(store, config, { now = Date.now(), generate = generateQuestion } = {}) {
  if (!config.autoGenerate || !config.firstTuesday || store.getMeta('paused') === 'true') return;
  const current = currentWeek(config.firstTuesday, now);
  // Prepare the current eligible release and the upcoming release ahead of time.
  for (const week of [current, current + 1]) {
    if (week > 520 || store.question(week)) continue;
    const { poll } = schedule(config.firstTuesday, week);
    if (now < poll - config.generationLeadDays * DAY || now > poll + config.pollGraceMinutes * 60_000) continue;
    const key = `generate_retry_${week}`;
    if (Number(store.getMeta(key) || 0) > now) continue;
    // Limit quota use even if the process crashes or generation fails.
    store.setMeta(key, now + 6 * 60 * 60_000);
    const q = await generate(config, week, store.questions());
    store.saveQuestion(q, { replace: false });
  }
}

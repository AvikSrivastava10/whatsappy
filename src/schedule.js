export const DAY = 86_400_000;
export const WEEK = 7 * DAY;

export function tuesday(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Date must be YYYY-MM-DD');
  const day = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(+day) || day.toISOString().slice(0, 10) !== date || day.getUTCDay() !== 2) throw new Error('Date must be a valid Tuesday');
  // Asia/Kolkata is UTC+05:30. Explicit offset avoids the host timezone.
  return Date.parse(`${date}T08:00:00+05:30`);
}

export function schedule(first, week) {
  if (!Number.isInteger(week) || week < 1 || week > 520) throw new Error('Week must be 1..520');
  const poll = tuesday(first) + (week - 1) * WEEK;
  return { poll, answer: poll + DAY };
}

export function currentWeek(first, now) {
  return Math.max(1, Math.floor((now - tuesday(first)) / WEEK) + 1);
}

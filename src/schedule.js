export const DAY = 86_400_000;
export const WEEK = 7 * DAY;

export function parseIST(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) {
    throw new Error('Enter date and time as YYYY-MM-DD HH:mm in IST (Asia/Kolkata)');
  }
  const [date, time] = value.split(' ');
  const day = new Date(`${date}T00:00:00Z`);
  const [hours, minutes] = time.split(':').map(Number);
  if (!Number.isFinite(+day) || day.toISOString().slice(0, 10) !== date || hours > 23 || minutes > 59) {
    throw new Error('Invalid IST calendar date or time');
  }
  return Date.parse(`${date}T${time}:00+05:30`);
}

export function customSchedule(pollInput, answerInput, now = Date.now()) {
  const poll = parseIST(pollInput);
  const answer = parseIST(answerInput);
  if (poll <= now) throw new Error('Poll date/time must be in the future');
  if (answer <= poll) throw new Error('Answer date/time must be after the poll');
  return { poll, answer };
}

export function formatIST(timestamp) {
  return `${new Date(timestamp + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')} IST (Asia/Kolkata)`;
}

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

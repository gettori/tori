const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * An age as one number and one letter, for a column that has no room for
 * "6 weeks ago": `3s`, `4m`, `3h`, `2d`, `6w`, `3M`, `1Y`. Whole units,
 * floored, so a thing is `1d` from the moment it is a day old until it is two.
 */
export function compactAge(unixSeconds: number, now = Date.now() / 1000): string {
  const age = Math.max(0, now - unixSeconds);
  if (age < MINUTE) return `${Math.floor(age)}s`;
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h`;
  if (age < WEEK) return `${Math.floor(age / DAY)}d`;
  if (age < MONTH) return `${Math.floor(age / WEEK)}w`;
  if (age < YEAR) return `${Math.floor(age / MONTH)}M`;
  return `${Math.floor(age / YEAR)}Y`;
}

/**
 * The same age as a phrase, for the sentences that used to write
 * `${compactAge(x)} ago`. Kept as the prose counterpart so callers do not each
 * have to append the suffix themselves.
 */
export function compactAgo(unixSeconds: number, now = Date.now() / 1000): string {
  return `${compactAge(unixSeconds, now)} ago`;
}

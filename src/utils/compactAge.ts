const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * An age as one number and one letter, for a column that has no room for
 * "6 weeks ago": `now`, `3H`, `2D`, `6W`, `3M`, `1Y`. Whole units, floored,
 * so a thing is `1D` from the moment it is a day old until it is two.
 */
export function compactAge(unixSeconds: number, now = Date.now() / 1000): string {
  const age = Math.max(0, now - unixSeconds);
  if (age < HOUR) return "now";
  if (age < DAY) return `${Math.floor(age / HOUR)}H`;
  if (age < WEEK) return `${Math.floor(age / DAY)}D`;
  if (age < MONTH) return `${Math.floor(age / WEEK)}W`;
  if (age < YEAR) return `${Math.floor(age / MONTH)}M`;
  return `${Math.floor(age / YEAR)}Y`;
}

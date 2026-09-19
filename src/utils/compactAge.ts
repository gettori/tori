const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * An age as one number and one letter, for a column that has no room for
 * "6 weeks ago": `now`, `3h`, `2d`, `6w`, `3m`, `1y`. Whole units, floored,
 * so a thing is `1d` from the moment it is a day old until it is two.
 */
export function compactAge(unixSeconds: number, now = Date.now() / 1000): string {
  const age = Math.max(0, now - unixSeconds);
  if (age < HOUR) return "now";
  if (age < DAY) return `${Math.floor(age / HOUR)}h`;
  if (age < WEEK) return `${Math.floor(age / DAY)}d`;
  if (age < MONTH) return `${Math.floor(age / WEEK)}w`;
  if (age < YEAR) return `${Math.floor(age / MONTH)}m`;
  return `${Math.floor(age / YEAR)}y`;
}

/**
 * The same age as a phrase, for the sentences that used to write
 * `${compactAge(x)} ago` and so rendered "Last commit now ago" for the first
 * hour. `now` is already a phrase and cannot take the suffix; every other step
 * can.
 *
 * Still the hour-resolution ramp, so this is for prose where "just now" is a
 * fine answer. A surface that needs to tell four minutes from forty wants its
 * own scale, the way `SyncChip.fetchedAgo` does.
 */
export function compactAgo(unixSeconds: number, now = Date.now() / 1000): string {
  const age = compactAge(unixSeconds, now);
  return age === "now" ? "just now" : `${age} ago`;
}

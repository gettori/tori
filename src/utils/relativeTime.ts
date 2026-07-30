/** How long ago, in the one compact form every session surface uses: `12s`,
 *  `4m`, `3h`, `9d`. Extracted from the sidebar so the History panel spells a
 *  session's age the same way its row does rather than inventing a second
 *  format for the same number. */
export function ago(epochSecs: number, now = Math.floor(Date.now() / 1000)): string {
  const s = Math.max(0, now - epochSecs);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

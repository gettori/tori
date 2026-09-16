// Version arithmetic for the one comparison the app makes: is the installed
// binary older than the version an adapter was measured against?
//
// Being *ahead* of the measurement is deliberately not a state anyone
// surfaces: vendors ship weekly, so a binary newer than `verified_against` is
// the steady condition of a healthy install. Being *behind* it is different in
// kind, not degree - the measured version exists, so a newer release provably
// does, and "update available" is a claim Tori can stand behind.

/** The dotted-number core of a version string, as numeric segments.
 *  Null when there is none: absence of evidence must compare as ignorance. */
function numericSegments(s: string | null | undefined): number[] | null {
  const m = s?.match(/\d+(?:\.\d+)*/);
  if (!m) return null;
  return m[0].split(".").map(Number);
}

/** The version half of a `verified_against` string ("claude 2.1.231"), or the
 *  string itself when it is already bare. For display beside a bare version. */
export function verifiedVersion(verifiedAgainst: string | null | undefined): string | null {
  return verifiedAgainst?.match(/\d+(?:\.\d+)*/)?.[0] ?? null;
}

/**
 * True only when `installed` is strictly older than the version inside
 * `verifiedAgainst`. Every unparseable or missing side answers false: a
 * warning built on a version nobody could read would be a guess wearing a
 * verdict's clothes.
 */
export function behindVerified(
  installed: string | null | undefined,
  verifiedAgainst: string | null | undefined,
): boolean {
  const have = numericSegments(installed);
  const want = numericSegments(verifiedAgainst);
  if (!have || !want) return false;
  for (let i = 0; i < Math.max(have.length, want.length); i++) {
    const a = have[i] ?? 0;
    const b = want[i] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}

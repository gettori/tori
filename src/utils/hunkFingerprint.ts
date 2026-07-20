// Content hash of a diff hunk, used to prove that the hunk the user clicked is
// still the hunk the backend is about to stage.
//
// Hunk *indices* are only meaningful against the exact diff they came from: an
// agent writing to the file between render and click renumbers them, so index 2
// can quietly become a different hunk. The UI therefore sends the fingerprint it
// rendered alongside the index, and the backend refuses if a fresh diff does not
// reproduce it.
//
// This must stay byte-for-byte identical to `fingerprint()` in
// `src-tauri/src/patch.rs`. Both suites assert the same locked value for the
// same input, so a drift fails the build rather than silently refusing every
// stage at runtime.

/** FNV-1a (32-bit) over the hunk's header and body, as 8 hex digits. */
export function hunkFingerprint(header: string, body: string[]): string {
  let hash = 0x811c9dc5;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      hash ^= s.charCodeAt(i) & 0xff;
      // Math.imul keeps the multiply in 32-bit space; `*` would lose precision.
      hash = Math.imul(hash, 0x01000193);
    }
  };
  feed(header);
  for (const line of body) {
    feed("\n");
    feed(line);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

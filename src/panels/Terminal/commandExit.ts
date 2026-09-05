// The wire half of a command tab's verdict. The backend's runner (runner.rs)
// prints `ESC ] 8791 ; <nonce> ; <code> BEL` when the command ends, and xterm's
// parser hands the payload here already reassembled, however it was chunked.

/** Mirrors `REPORT_OSC` in runner.rs. Outside every sequence a user's shell
 *  integration may already emit (7, 9, 133, 633, 777, 1337). */
export const COMMAND_EXIT_OSC = 8791;

/** The exit code in a report for `nonce`, or null for anything else: another
 *  run's nonce, a replayed log, a payload that is not `<nonce>;<int>`, or any
 *  report before the spawn has answered with a nonce to check against. */
export function parseCommandExit(payload: string, nonce: string | null): number | null {
  if (!nonce) return null;
  const sep = payload.indexOf(";");
  if (sep < 0 || payload.slice(0, sep) !== nonce) return null;
  const code = payload.slice(sep + 1);
  return /^\d+$/.test(code) ? Number(code) : null;
}

import type { SecretHit } from "./chatTypes";
import { turnWatch, type SessionTarget } from "./turnWatch";

/** One turn's secret reads. `promptTs` is null for a history with no prompts
 *  to anchor on, which is an ACP log. */
export type SecretTurn = { promptTs: number | null; paths: string[]; strength: SecretHit["strength"] };

export type SecretTarget = SessionTarget;

const secrets = turnWatch<SecretTurn>("session_secrets");

export const secretTurnsOf = secrets.turnsOf;

export function sessionSecret(sessionId: string): SecretHit | null {
  const turns = secretTurnsOf(sessionId);
  if (!turns.length) return null;
  return {
    paths: [...new Set(turns.flatMap((t) => t.paths))].sort(),
    strength: turns.some((t) => t.strength === "read") ? "read" : "named",
  };
}

export function secretLabel(hit: SecretHit): string {
  if (hit.paths.length !== 1) return `${hit.paths.length} secret files`;
  const name = hit.paths[0].split("/").filter(Boolean).pop() ?? hit.paths[0];
  return hit.strength === "read" ? `Read ${name}` : `Command named ${name}`;
}

export function commandAround(command: string, path: string, width = 60): string {
  const line = command.replace(/\s+/g, " ").trim();
  if (line.length <= width) return line;
  const at = Math.max(0, line.indexOf(path));
  const start = Math.max(0, Math.min(at - Math.floor((width - path.length) / 2), line.length - width));
  const cut = line.slice(start, start + width);
  return `${start > 0 ? "..." : ""}${cut}${start + width < line.length ? "..." : ""}`;
}

/** Keep the marks for exactly the live sessions in `targets`. */
export const watchSecrets = secrets.watch;

export const resetSecretReadsForTests = secrets.reset;

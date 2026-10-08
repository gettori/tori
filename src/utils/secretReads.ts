import type { SecretHit } from "./chatTypes";
import { turnWatch, type SessionTarget } from "./turnWatch";

/** One turn's secret reads. `promptTs` is null for a history with no prompts
 *  to anchor on, which is an ACP log. */
export type SecretTurn = { promptTs: number | null; paths: string[]; strength: SecretHit["strength"] };

export type SecretTarget = SessionTarget;

const secrets = turnWatch<SecretTurn>("session_secrets");

export const secretTurnsOf = secrets.turnsOf;

/** The session's strongest claim, or null when it touched nothing. */
export function sessionSecret(sessionId: string): SecretHit["strength"] | null {
  const turns = secretTurnsOf(sessionId);
  if (!turns.length) return null;
  return turns.some((t) => t.strength === "read") ? "read" : "named";
}

/** Keep the marks for exactly the live sessions in `targets`. */
export const watchSecrets = secrets.watch;

export const resetSecretReadsForTests = secrets.reset;

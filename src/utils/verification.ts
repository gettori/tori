import { invoke } from "@tauri-apps/api/core";
import { formatDuration } from "../panels/Chat/toolRenderers";
import { saveSettings, settings } from "../panels/Settings/settingsStore";
import type { Check, Verdict } from "./chatTypes";
import { turnWatch } from "./turnWatch";

/** One turn that changed code. `promptTs` is null for a history with no
 *  prompts to anchor on, which is an ACP log. */
export type VerifiedTurn = { promptTs: number | null; verdict: Verdict; checks: Check[] };

export const VERDICT_LABEL: Record<Verdict, string> = {
  verified: "Verified",
  failed: "Checks failed",
  unverified: "Unverified",
};

/** One check as a tooltip line: "cargo test: passed in 14.2s". */
export function checkLine(c: Check): string {
  const took = formatDuration(c.durationMs);
  switch (c.result) {
    case "passed":
      return `${c.command}: passed${took ? ` in ${took}` : ""}`;
    case "failed":
      return `${c.command}: failed${c.exitCode !== null ? `, exit ${c.exitCode}` : ""}${took ? ` after ${took}` : ""}`;
    case "notSeen":
      return `${c.command}: ran, exit not seen`;
  }
}

/** The whole answer for a tooltip: what decided it, then every check. */
export function verdictDetail(verdict: Verdict, checks: readonly Check[]): string {
  const head =
    verdict === "unverified" && !checks.length
      ? "Changed code and ran no check."
      : verdict === "unverified"
        ? "No check after the last edit, or its exit was not seen."
        : verdict === "failed"
          ? "The last check after the last edit failed."
          : "The last check after the last edit passed.";
  return [head, ...checks.map(checkLine)].join("\n");
}

const verified = turnWatch<VerifiedTurn>("session_verification");

export const verifiedTurnsOf = verified.turnsOf;

/** The latest code-changing turn's verdict, so a later fix clears an earlier
 *  failure. Null for a session that changed no code. */
export function sessionVerdict(sessionId: string): Verdict | null {
  const turns = verifiedTurnsOf(sessionId);
  return turns[turns.length - 1]?.verdict ?? null;
}

/** Keep the verdicts for exactly the live sessions in `targets`. */
export const watchVerification = verified.watch;

export const resetVerificationForTests = verified.reset;

/** The commands that count as a check in a project, as written: its own list,
 *  else the built-in one. */
export const projectChecks = (projectPath: string) =>
  invoke<string[]>("verification_commands", { project: projectPath });

/** The built-in list, which a project with no list of its own uses. */
export const builtInChecks = () => invoke<string[]>("verification_defaults");

/** Replace the commands that count as a check in one project. None returns it
 *  to the built-in list. */
export function setProjectChecks(projectPath: string, commands: string[]): Promise<void> {
  const next = { ...settings.verification.commands };
  if (commands.length) next[projectPath] = commands;
  else delete next[projectPath];
  return saveSettings({ ...settings, verification: { ...settings.verification, commands: next } });
}

import { invoke } from "@tauri-apps/api/core";
import type { DiffHunk } from "./diffHunks";

export type SessionLabel = { id: string; agent: string; title: string };

export type TurnRef = {
  session: SessionLabel;
  /** 1-based among the session's prompt boundaries. */
  ordinal: number;
  promptTs: number;
  prompt: string | null;
};

export type CallRef = {
  toolUseId: string;
  name: string;
  kind: string;
  /** The file's path or name appears in the call's input. */
  namesFile: boolean;
  input: Record<string, unknown>;
  /** The nearest prose the agent wrote before the call. */
  reply: string | null;
};

export type NoneReason = "before" | "capped" | "unrecorded" | "overlapping" | "unseen" | "outside";

export type Claim =
  | { tier: "call"; turn: TurnRef; call: CallRef }
  | { tier: "candidates"; turn: TurnRef; calls: CallRef[] }
  | { tier: "shell"; turn: TurnRef; calls: CallRef[] }
  | { tier: "none"; reason: NoneReason; sessions: SessionLabel[] };

/** Lines `start` to `start + count - 1` carry `claim`; count 0 is a deletion
 *  after `start`. */
export type ClaimRange = { start: number; count: number; claim: Claim };

/** How many of a turn's calls the panel lists before counting the rest. */
export const CALLS_SHOWN = 3;

/** Why a hunk could not be read, said to the reader rather than shown as an
 *  empty claim. */
export type ReadFailure = { error: string };

/** Reads who wrote each changed line of one hunk, against whatever tree the
 *  view's diff ends at. */
export type ClaimReader = (hunk: DiffHunk) => Promise<ClaimRange[] | ReadFailure>;

/** A reader over one of the provenance commands, which all take the hunks as
 *  their raw text and parse them on the Rust side. */
export function claimsVia(command: string, args: Record<string, unknown>): ClaimReader {
  return async (hunk) => {
    try {
      const out = await invoke<ClaimRange[][]>(command, { ...args, hunks: [[hunk.header, ...hunk.lines].join("\n")] });
      return out[0] ?? [];
    } catch (e) {
      return { error: String(e) };
    }
  };
}

/** The diff tab's: the working tree, or the index when the diff is staged. */
export function diffTabClaims(root: string, file: string, staged: boolean): ClaimReader {
  return claimsVia("diff_provenance", { projectPath: root, file, staged });
}

function titleOf(session: SessionLabel): string {
  return session.title.trim() || session.id.slice(0, 8);
}

function names(sessions: SessionLabel[]): string {
  const all = sessions.map(titleOf);
  if (all.length <= 1) return all[0] ?? "a session";
  return `${all.slice(0, -1).join(", ")} and ${all[all.length - 1]}`;
}

/** Where a turn sits: its session and its number. */
export function turnLabel(turn: TurnRef): string {
  return `turn ${turn.ordinal} of ${titleOf(turn.session)}`;
}

/** The first line of a call's command or the file it names, for one row. */
export function callSummary(call: CallRef): string {
  const command = call.input.command;
  const path = call.input.file_path ?? call.input.path;
  const detail = typeof command === "string" ? command : typeof path === "string" ? path : "";
  const first = detail.split("\n")[0] ?? "";
  return first ? `${call.name} ${first}` : call.name;
}

/** A turn's calls, the ones naming the file first, as a long turn can hold
 *  dozens of shell commands. */
export function orderedCalls(calls: CallRef[]): CallRef[] {
  return [...calls.filter((c) => c.namesFile), ...calls.filter((c) => !c.namesFile)];
}

/** One sentence saying who wrote the range, as strongly as the claim is. */
export function claimHeadline(claim: Claim): string {
  switch (claim.tier) {
    case "call":
      return `Written by ${claim.call.name} in ${turnLabel(claim.turn)}.`;
    case "candidates":
      return claim.calls.length
        ? `Written in ${turnLabel(claim.turn)} by one of ${claim.calls.length} calls. The record does not say which.`
        : `Written in ${turnLabel(claim.turn)}. Tori could not read back which call.`;
    case "shell":
      return claim.calls.length === 1
        ? `Written by a shell command in ${turnLabel(claim.turn)}.`
        : `Written by one of ${claim.calls.length} shell commands in ${turnLabel(claim.turn)}. None names the file for certain.`;
    case "none":
      switch (claim.reason) {
        case "before":
          return "No session Tori recorded wrote this. It was already there at the first checkpoint.";
        case "capped":
          return "Older than the changes Tori walks back through, so no turn is named.";
        case "unrecorded":
          return `Written during a turn of ${names(claim.sessions)}, which Tori ran but cannot read back.`;
        case "overlapping":
          return `${names(claim.sessions)} were each in a turn that could have written this, so Tori names none of them.`;
        case "unseen":
          return "No session Tori knows of was in a turn when this was written: by hand, or by a session Tori did not see.";
        case "outside":
          return "Written outside any session Tori saw. No worktree here holds this pull request's branch.";
      }
  }
}

/** Which lines a range covers, for a hunk whose lines more than one turn wrote. */
export function rangeLabel(range: ClaimRange): string {
  if (range.count === 0) return `Removed after line ${range.start}`;
  if (range.count === 1) return `Line ${range.start}`;
  return `Lines ${range.start} to ${range.start + range.count - 1}`;
}

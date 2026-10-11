/** Mirrors `ReviewUnit` in src-tauri/src/review/mod.rs. */
export type ReviewUnit = { kind: "session"; id: string };

/** Mirrors `SignalKind` in src-tauri/src/review/mod.rs. */
export type SignalKind =
  | "lines"
  | "secretRead"
  | "failed"
  | "blindEdit"
  | "unverified"
  | "deletedTests"
  | "sensitivePath"
  | "dependencies"
  | "outsideScope"
  | "sharedFile"
  | "noCheckpoints";

export type ReviewSignal = { kind: SignalKind; count: number; points: number };

/** Mirrors `ReviewItem` in src-tauri/src/review/mod.rs. */
export type ReviewItem = {
  unit: ReviewUnit;
  project: string;
  folder: string;
  agent: string;
  title: string;
  summary: string | null;
  score: number;
  signals: ReviewSignal[];
  fromTs: number | null;
  toTs: number;
  running: boolean;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function signalLabel(signal: ReviewSignal): string {
  switch (signal.kind) {
    case "lines":
      return plural(signal.count, "line");
    case "secretRead":
      return `Secret read in ${plural(signal.count, "turn")}`;
    case "failed":
      return `Checks failed in ${plural(signal.count, "turn")}`;
    case "blindEdit":
      return `${plural(signal.count, "edit")} without reading`;
    case "unverified":
      return plural(signal.count, "unverified turn");
    case "deletedTests":
      return `${plural(signal.count, "test file")} deleted`;
    case "sensitivePath":
      return plural(signal.count, "CI, auth or secret file");
    case "dependencies":
      return `${plural(signal.count, "manifest or lockfile", "manifests or lockfiles")} changed`;
    case "outsideScope":
      return `${plural(signal.count, "file")} outside the named folders`;
    case "sharedFile":
      return `${plural(signal.count, "file")} shared with another session`;
    case "noCheckpoints":
      return "No checkpoints";
  }
}

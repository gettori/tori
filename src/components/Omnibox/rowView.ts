import type { CommandGroup } from "../../utils/commands";
import type { Range } from "../../utils/fuzzy";
import { GROUP_LABELS } from "../../utils/hotkeys";
import type { OmniMode } from "../../utils/omniboxModes";
import type { Place, PlaceDot, PlaceKind } from "../../utils/navIndex";

type RowBase = {
  id: string;
  label: string;
  sub?: string;
  /** Heading this row sits under. Rows carrying the same one must be adjacent;
   *  the header renders once, where the value changes. */
  section?: string;
  marks?: Range[];
  subMarks?: Range[];
  /** Why this cannot run right now, or null when it can. */
  disabled?: string | null;
  run?: () => void;
};

export type Row =
  | (RowBase & { kind: "file"; file: string })
  | (RowBase & { kind: "command"; group: CommandGroup; keys?: string[] })
  | (RowBase & { kind: "symbol"; symbolKind: number })
  | (RowBase & { kind: "line" })
  | (RowBase & { kind: "help"; mode: OmniMode; prefix: string })
  | (RowBase & { kind: "place"; place: Place });

export type RowIcon =
  | { kind: "file"; name: string }
  | { kind: "symbol"; symbolKind: number }
  | { kind: "group"; group: CommandGroup }
  | { kind: "mode"; mode: OmniMode }
  | { kind: "place"; place: PlaceKind; unitKind?: string; look?: Place["look"] };

export type RowView = {
  icon: RowIcon;
  title: string;
  marks: Range[];
  subtitle?: string;
  subMarks: Range[];
  keys?: { chips: string[]; spoken: string };
  ticket?: { label: string; spoken: string };
  pr?: { label: string; tone: string; spoken: string };
  dot?: { tone: PlaceDot; spoken: string };
  word?: string;
};

export const ENTER_LABEL: Record<Row["kind"], string> = {
  file: "Open",
  command: "Run",
  symbol: "Go",
  line: "Go",
  help: "Use filter",
  place: "Go",
};

const DOT_SPOKEN: Record<PlaceDot, string> = { needsYou: "Waiting on you", working: "Working" };

function placeWord(place: Place): string {
  if (place.kind !== "unit") return place.kind[0].toUpperCase() + place.kind.slice(1);
  if (place.unitKind === "worktree") return "Worktree";
  return place.unitKind === "plain" ? "Branch" : "Folder";
}

const SPOKEN: Record<string, string> = {
  "\u2318": "Command",
  "\u2325": "Option",
  "\u21e7": "Shift",
  "\u2303": "Control",
  "\u2190": "Left Arrow",
  "\u2192": "Right Arrow",
  "\u2212": "Minus",
};

function chord(chips: string[]): RowView["keys"] {
  return { chips, spoken: chips.map((c) => SPOKEN[c] ?? c).join(" ") };
}

export function rowView(row: Row): RowView {
  const base = {
    title: row.label,
    marks: row.marks ?? [],
    subtitle: row.disabled ?? row.sub,
    subMarks: row.subMarks ?? [],
  };
  switch (row.kind) {
    case "file":
      return { ...base, icon: { kind: "file", name: row.file } };
    case "command":
      return {
        ...base,
        icon: { kind: "group", group: row.group },
        subtitle: base.subtitle ?? GROUP_LABELS[row.group],
        keys: row.keys && chord(row.keys),
      };
    case "symbol":
      return { ...base, icon: { kind: "symbol", symbolKind: row.symbolKind } };
    case "line":
      return { ...base, icon: { kind: "mode", mode: "line" } };
    case "help":
      return { ...base, icon: { kind: "mode", mode: row.mode }, keys: row.prefix ? chord([row.prefix]) : undefined };
    case "place": {
      const { kind, unitKind, look, issue, pr, dot } = row.place;
      return {
        ...base,
        icon: { kind: "place", place: kind, unitKind, look },
        ticket: issue && { label: issue.display, spoken: `Issue ${issue.display}` },
        pr: pr && { label: `#${pr.number}`, tone: pr.tone, spoken: `Pull request ${pr.number}, ${pr.title}` },
        dot: dot && { tone: dot, spoken: DOT_SPOKEN[dot] },
        word: placeWord(row.place),
      };
    }
  }
}

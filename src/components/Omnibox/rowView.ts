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
  browse?: () => void;
  keywords?: string[];
  run?: () => void;
};

export type Meter = { level: number; warn: boolean };

export type Row =
  | (RowBase & { kind: "file"; file: string })
  | (RowBase & { kind: "command"; group: CommandGroup; keys?: string[]; value?: string; check?: "on" | "off" })
  | (RowBase & { kind: "symbol"; symbolKind: number })
  | (RowBase & { kind: "line" })
  | (RowBase & { kind: "help"; mode: OmniMode; prefix: string })
  | (RowBase & { kind: "place"; place: Place; ticketMarks?: Range[]; prMarks?: Range[] })
  | (RowBase & { kind: "lookup"; pending: boolean })
  | (RowBase & { kind: "create"; word?: string })
  | (RowBase & { kind: "retype"; mode: OmniMode; text: string })
  | (RowBase & { kind: "theme"; themeId: string; swatches: string[]; current: boolean })
  | (RowBase & { kind: "usage"; agentId: string; meter: Meter });

export type RowIcon =
  | { kind: "file"; name: string }
  | { kind: "symbol"; symbolKind: number }
  | { kind: "group"; group: CommandGroup }
  | { kind: "mode"; mode: OmniMode }
  | { kind: "place"; place: PlaceKind; unitKind?: string; look?: Place["look"] }
  | { kind: "lookup" }
  | { kind: "create" }
  | { kind: "theme" }
  | { kind: "agent"; agentId: string; label: string };

type Chip = { label: string; spoken: string; marks: Range[] };

export type RowView = {
  icon: RowIcon;
  title: string;
  marks: Range[];
  subtitle?: string;
  subMarks: Range[];
  keys?: { chips: string[]; spoken: string };
  ticket?: Chip;
  pr?: Chip & { tone: string };
  dot?: { tone: PlaceDot; spoken: string };
  word?: string;
  swatches?: string[];
  check?: "on" | "off";
  value?: string;
  meter?: Meter;
};

export const ENTER_LABEL: Record<Row["kind"], string> = {
  file: "Open",
  command: "Run",
  symbol: "Go",
  line: "Go",
  help: "Use filter",
  place: "Go",
  lookup: "Look up",
  create: "Create",
  retype: "Search",
  theme: "Apply",
  usage: "Details",
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
        value: row.value,
        check: row.check,
      };
    case "symbol":
      return { ...base, icon: { kind: "symbol", symbolKind: row.symbolKind } };
    case "line":
      return { ...base, icon: { kind: "mode", mode: "line" } };
    case "help":
      return { ...base, icon: { kind: "mode", mode: row.mode }, keys: row.prefix ? chord([row.prefix]) : undefined };
    case "place": {
      const { kind, unitKind, look, ticket, pr, dot } = row.place;
      return {
        ...base,
        icon: { kind: "place", place: kind, unitKind, look },
        ticket: ticket && { label: ticket.label, spoken: `Issue ${ticket.label}`, marks: row.ticketMarks ?? [] },
        pr: pr && {
          label: `#${pr.number}`,
          tone: pr.tone,
          spoken: `Pull request ${pr.number}, ${pr.title}${pr.remembered ? ", as last seen" : ""}`,
          marks: row.prMarks ?? [],
        },
        dot: dot && { tone: dot, spoken: DOT_SPOKEN[dot] },
        word: placeWord(row.place),
      };
    }
    case "lookup":
      return { ...base, icon: { kind: "lookup" } };
    case "create":
      return { ...base, icon: { kind: "create" }, word: row.word };
    case "retype":
      return { ...base, icon: { kind: "mode", mode: row.mode } };
    case "theme":
      return { ...base, icon: { kind: "theme" }, swatches: row.swatches, check: row.current ? "on" : "off" };
    case "usage":
      return { ...base, icon: { kind: "agent", agentId: row.agentId, label: row.label }, meter: row.meter };
  }
}

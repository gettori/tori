import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal } from "solid-js";
import { fuzzyScore } from "../../utils/fuzzy";
import Combobox, { type ComboboxGroup, type ComboboxOption } from "./Combobox";

const BRANCHES: ComboboxOption[] = [
  "main",
  "develop",
  "feature/omnibox",
  "feature/combobox",
  "fix/scroll-into-view",
].map((value) => ({ value, label: value }));

/** The long list the picker exists for: attaching one of hundreds of branches
 *  is what replaced a comma-joined prompt title. */
const MANY: ComboboxOption[] = Array.from({ length: 200 }, (_, i) => ({
  value: `feature/branch-${i + 1}`,
  label: `feature/branch-${i + 1}`,
}));

const COMMANDS: ComboboxOption[] = [
  { value: "new-session", label: "New Claude session" },
  { value: "stop", label: "Stop the running agent", disabled: true },
  { value: "settings", label: "Open Settings" },
];

const FILES: ComboboxGroup[] = [
  {
    label: "Recently visited",
    options: [
      { value: "src/App.tsx", label: "src/App.tsx" },
      { value: "src/lib/combobox.ts", label: "src/lib/combobox.ts" },
    ],
  },
  {
    label: "Everything else",
    options: [
      { value: "src/utils/fuzzy.ts", label: "src/utils/fuzzy.ts" },
      { value: "src/components/Combobox/Combobox.tsx", label: "src/components/Combobox/Combobox.tsx" },
    ],
  },
];

/** Filter and rank exactly as the real callers do: the wrapper never re-orders,
 *  so the story has to, or the stories would demo a list nobody ships. */
function ranked(all: ComboboxOption[], query: string): ComboboxOption[] {
  const q = query.trim();
  if (!q) return all;
  return all
    .map((option) => ({ option, score: fuzzyScore(q, option.label) }))
    .filter((hit): hit is { option: ComboboxOption; score: number } => hit.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((hit) => hit.option);
}

const meta = {
  title: "Components/Combobox",
  component: Combobox,
  args: {
    options: BRANCHES,
    query: "",
    onQueryChange: () => {},
    onSelect: () => {},
    "aria-label": "Filter branches",
  },
} satisfies Meta<typeof Combobox>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The default surface: a filter over a short list, already open, with the top
 *  match live so Enter commits it without touching an arrow key. */
export const Default: Story = {
  render: () => {
    const [query, setQuery] = createSignal("");
    return (
      <Combobox
        options={ranked(BRANCHES, query())}
        query={query()}
        onQueryChange={setQuery}
        onSelect={() => {}}
        placeholder="Filter branches"
        aria-label="Filter branches"
        listLabel="Branches"
        emptyLabel="No matches"
      />
    );
  },
};

/** 200 rows: the field stays put and the list scrolls under it, which is what
 *  keeps the filter reachable once the list is longer than the surface. */
export const LongList: Story = {
  render: () => {
    const [query, setQuery] = createSignal("");
    return (
      <div style={{ display: "flex", "flex-direction": "column", "max-height": "320px" }}>
        <Combobox
          options={ranked(MANY, query())}
          query={query()}
          onQueryChange={setQuery}
          onSelect={() => {}}
          placeholder="Filter branches"
          aria-label="Filter branches"
          listLabel="Branches"
          emptyLabel="No matches"
        />
      </div>
    );
  },
};

/** Nothing matches. The list is *withdrawn* rather than emptied: a listbox
 *  promises selectable children, so one with none is worse than none at all,
 *  and the combobox reports itself collapsed rather than pointing at a list
 *  that is no longer there. */
export const Empty: Story = {
  render: () => {
    const [query, setQuery] = createSignal("zzz");
    return (
      <Combobox
        options={ranked(BRANCHES, query())}
        query={query()}
        onQueryChange={setQuery}
        placeholder="Filter branches"
        onSelect={() => {}}
        aria-label="Filter branches"
        listLabel="Branches"
        emptyLabel="No matches"
      />
    );
  },
};

/** Rows carrying more than a label, the palette's shape, plus one row that
 *  cannot be picked. A disabled row is muted through role tokens rather than
 *  opacity, and the arrow keys step straight past it. */
export const RichRows: Story = {
  render: () => {
    const [query, setQuery] = createSignal("");
    return (
      <Combobox
        options={ranked(COMMANDS, query())}
        query={query()}
        onQueryChange={setQuery}
        onSelect={() => {}}
        placeholder="Type a command"
        aria-label="Type a command"
        listLabel="Commands"
        emptyLabel="No matches"
        itemComponent={(option) => (
          <span style={{ display: "flex", "align-items": "center", gap: "var(--tori-space-3)", flex: 1 }}>
            <span style={{ flex: 1 }}>{option.label}</span>
            <span style={{ color: "var(--fg-subtle)", "font-size": "var(--tori-text-sm)" }}>
              {option.disabled ? "unavailable" : "Enter"}
            </span>
          </span>
        )}
      />
    );
  },
};

/** Grouped rows, the palette's file list: a heading names each run. A list is
 *  either wholly grouped or wholly flat, never mixed, because Kobalte reads the
 *  children key off every top-level entry and throws on the first bare one. */
export const Groups: Story = {
  render: () => (
    <Combobox
      options={FILES}
      query=""
      onQueryChange={() => {}}
      onSelect={() => {}}
      placeholder="Go to file"
      aria-label="Go to file"
      listLabel="Files"
      emptyLabel="No matching files"
    />
  ),
};

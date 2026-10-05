// The parts every settings pane is built from: the row primitives, the writers
// that go through `saveSettings`, and the coercion the number fields need.
//
// All of this lived inside `Settings.tsx`'s component closure until the panel
// became six panes, and six components cannot share one closure. Nothing here
// closes over anything per-render - only over the imported store - so the move
// was a move rather than a rewrite.
import { createSignal, For, Show, type JSX } from "solid-js";
import { Check, Copy } from "lucide-solid";
import { copyText } from "../../../utils/clipboard";
import { hintRanges, labelRanges, segments, type Range } from "../utils/searchHighlight";
import {
  SETTINGS,
  SETTING_TABS,
  tabOfEntry,
  type SettingEntry,
  type SettingSection,
  type SettingTab,
  type EditorToggleKey,
} from "../../../utils/settingsCatalog";
import Button from "../../../components/Button/Button";
import Icon from "../../../components/Icon/Icon";
import IconButton from "../../../components/IconButton/IconButton";
import {
  settings,
  saveSettings,
  editorDefaults,
  editorOrigin,
  overlayRoot,
  setEditorDefault,
  setWorkspaceOverride,
  type Appearance,
  type Budgets,
  type ChatDefaults,
  type Checkpoints,
  type Alert,
  type GitSettings,
  type NotificationSettings,
  type PanePins,
  type Agent,
  type AutopilotSettings,
  type Typography,
  type ActiveLineHighlight,
  type EditorDefaults,
} from "../settingsStore";
import styles from "../Settings.module.css";
import Tooltip from "../../../components/Tooltip/Tooltip";
import Switch from "../../../components/Switch/Switch";
import Select, { type SelectOption } from "../../../components/Select/Select";

// Font inputs show only the primary family; the app's fallback stack is kept
// out of the field and re-attached on save, so a user types "JetBrains Mono"
// rather than editing a whole CSS list (and never accidentally drops the
// system fallbacks). One stack per surface.
export const UI_FONT_FALLBACK = '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';
export const EDITOR_FONT_FALLBACK = "Menlo, Monaco, monospace";
export const TERMINAL_FONT_FALLBACK = "Menlo, Monaco, monospace";

/** Rebuild a full stack from a user-entered primary name plus the surface's
 *  fallbacks. A blank entry falls back to the stack alone (no leading comma).
 *  Names with spaces are quoted so the CSS value stays valid. */
export function withFallback(primary: string, fallback: string): string {
  const name = primary.trim();
  if (!name) return fallback;
  const quoted = /\s/.test(name) ? `"${name}"` : name;
  return `${quoted}, ${fallback}`;
}

// Reject empty/NaN/out-of-range commits (a blank or 0 font size would blank
// the UI); fall back to the current value so an invalid entry is a no-op.
export function clamp(v: string, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (v.trim() === "" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// A ceiling is opt-in, so a blank field is the *unset* value rather than an
// invalid one. `clamp` cannot express that: it falls back to the previous
// value, which would make a ceiling impossible to clear once set.
export function optionalNumber(v: string, min: number): number | null {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : null;
}

export const setAppearance = (a: Partial<Appearance>) =>
  saveSettings({ ...settings, appearance: { ...settings.appearance, ...a } });
export const setTypography = (t: Partial<Typography>) =>
  saveSettings({ ...settings, typography: { ...settings.typography, ...t } });
export const setGit = (g: Partial<GitSettings>) => saveSettings({ ...settings, git: { ...settings.git, ...g } });
export const setAlert = (state: keyof NotificationSettings, a: Partial<Alert>) =>
  saveSettings({
    ...settings,
    notifications: { ...settings.notifications, [state]: { ...settings.notifications[state], ...a } },
  });
export const setCheckpoints = (c: Partial<Checkpoints>) =>
  saveSettings({ ...settings, checkpoints: { ...settings.checkpoints, ...c } });
export const setChatDefaults = (c: Partial<ChatDefaults>) =>
  saveSettings({ ...settings, chatDefaults: { ...settings.chatDefaults, ...c } });
export const setPanePins = (p: Partial<PanePins>) =>
  saveSettings({ ...settings, panePins: { ...settings.panePins, ...p } });
export const setBudgets = (b: Partial<Budgets>) =>
  saveSettings({ ...settings, budgets: { ...settings.budgets, ...b } });
export const setAgent = (h: Partial<Agent>) => saveSettings({ ...settings, agent: { ...settings.agent, ...h } });
export const setAutopilot = (a: Partial<Omit<AutopilotSettings, "enabled">>) =>
  saveSettings({ ...settings, autopilot: { ...settings.autopilot, ...a } });

/** The workspace an override would be written to, by its folder name. The
 *  editor pane owns which workspace is selected; the panel reads it rather than
 *  taking a prop, since it is opened from the top bar and from the palette and
 *  neither of those knows. */
export const workspaceName = () => overlayRoot()?.split("/").pop() ?? "";

export type EditorToggle = { id: string; key: EditorToggleKey; label: string; hint?: string };

/** The boolean editor rows of one section, read off the catalogue so a setting
 *  is named in exactly one place (see `utils/settingsCatalog.ts`). */
export function togglesIn(section: SettingSection): EditorToggle[] {
  return SETTINGS.filter((s) => s.section === section && s.toggles).map((s) => ({
    id: s.id,
    key: s.toggles!,
    label: s.label,
    hint: s.hint,
  }));
}

/** The editing-comfort toggles, in the order they read as a list rather than in
 *  the order the wave built them: what the text looks like, then what the
 *  editor does for you, then what survives a quit. */
export const EDITOR_TOGGLES = togglesIn("editing");

/** The two editor preferences that are behaviour rather than editing *comfort*.
 *  Their own group above the list, because each needs a paragraph the rest do
 *  not. */
export const OWN_ROW_TOGGLES = togglesIn("editor");

/** An editing setting that is not a switch, read off the catalogue like
 *  the toggles are so its label and hint are still named in one place. Found by
 *  the key it edits rather than by its id, so the row and the setting cannot
 *  drift apart the way two strings can. */
export const TODO_TAGS: SettingEntry = SETTINGS.find((s) => s.edits === "todoPatterns")!;

/** The other one, found the same way. */
export const ACTIVE_LINE: SettingEntry = SETTINGS.find((s) => s.edits === "activeLineHighlight")!;

/** And the tab size, found the same way. */
export const TAB_SIZE: SettingEntry = SETTINGS.find((s) => s.edits === "tabSize")!;

/** What a pane needs from the shell: which rows the query left on screen, and
 *  the query itself so a row can mark *why* it is one of them. `shown` answers
 *  true for everything when nothing is typed, so a pane never has to ask whether
 *  a search is running; `query` is `""` then, which marks nothing. */
export type PaneProps = {
  shown: (id: string) => boolean;
  query: string;
  /** The category this pane belongs to, set **only** while a search is running.
   *  Results from all six panes are one list then, so a group heading has to say
   *  where its rows came from; "Editing" alone does not place them. */
  prefix?: string;
  /** Go to a category and stop searching. What a card section offers instead of
   *  unfolding its whole runtime contents into a list of search results. */
  openTab?: (tab: SettingTab) => void;
  /** The folder the workspace is currently on, or `null` for an empty
   *  Topic. Read by the Agents pane, whose file actions open an editor
   *  tab and so need a workspace to open it in. */
  projectRoot?: string | null;
  /** Shut the panel. For an action whose result is the workspace itself
   *  changing, where staying open leaves a modal over a screen the user has
   *  just replaced. Only Advanced uses it. */
  onClose?: () => void;
};

/** The DOM id of a setting's row, so a palette deep link can find it. Derived
 *  from the catalogue id rather than stored, so there is nothing to keep in
 *  step. */
export const rowDomId = (id: string) => `settings-row-${id}`;

/** The DOM id of a row's visible label, for a control that cannot be wrapped by
 *  a `<label>`: `Select` renders a button, which takes no `for`. Pointing the
 *  control at this id is what gives it an accessible name, and it is the row's
 *  own label text, so the name and what is on screen cannot drift. Derived the
 *  same way `rowDomId` is, for the same reason. */
export const rowLabelId = (id: string) => `settings-label-${id}`;

/**
 * A label or hint with the matched part marked.
 *
 * The ranges come from `searchHighlight`, which is pinned to the matcher that
 * decided this row is on screen at all - so what is marked is the actual reason
 * the badge counted it, not a second guess at one.
 */
export function Mark(props: { text: string; ranges: Range[] }) {
  return (
    <For each={segments(props.text, props.ranges)}>
      {(seg) => (seg.marked ? <mark class={styles.mark}>{seg.text}</mark> : <>{seg.text}</>)}
    </For>
  );
}

/** A row's label, marked where the query matched it. */
const MarkedLabel = (props: { query: string; text: string }) => (
  <Mark text={props.text} ranges={labelRanges(props.query, props.text)} />
);

/** A row's hint, marked where the query matched it. */
const MarkedHint = (props: { query: string; text: string }) => (
  <Mark text={props.text} ranges={hintRanges(props.query, props.text)} />
);

/** The catalogue ids belonging to one section, which is what a `Group` covering
 *  a whole section passes as its `ids`. Derived rather than written out, so a
 *  setting added to the section joins its group without a second edit. */
export const idsIn = (section: SettingSection): string[] =>
  SETTINGS.filter((s) => s.section === section).map((s) => s.id);

/**
 * A titled group of rows inside a pane.
 *
 * `ids` is what the group covers, and the heading disappears when a query has
 * filtered all of them away: a lone heading over nothing reads as a section
 * that failed to load rather than as one with no match in it.
 */
export function Group(props: {
  shown: (id: string) => boolean;
  title: string;
  ids: string[];
  /** Passed down by every pane via `{...props}`; set only while searching. */
  prefix?: string;
  children: JSX.Element;
}) {
  return (
    <Show when={props.ids.some((id) => props.shown(id))}>
      <section class={styles.section}>
        <div class={styles.sectionTitle}>
          {/* One span, so `section > div:first-child` still reads back the
              title alone - the rule beside it carries no text. */}
          <span>{props.prefix ? `${props.prefix} · ${props.title}` : props.title}</span>
          <span class={styles.sectionRule} />
        </div>
        {props.children}
      </section>
    </Show>
  );
}

/** A command the user could run themselves, with the one control that keeps
 *  the promise honest: copy, exactly as shown. */
export function CmdLine(props: { text: string }) {
  const [copied, setCopied] = createSignal(false);
  const copy = async () => {
    if (!(await copyText(props.text))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div class={styles.cmd}>
      <span class={styles.cmdPrompt}>$</span>
      <code class={styles.cmdText}>{props.text}</code>
      <button type="button" class={styles.cmdCopy} onClick={() => void copy()}>
        {copied() ? "copied" : "copy"}
      </button>
    </div>
  );
}

/** A command in a read-only field, with a copy button at its end. A field
 *  rather than `CmdLine` where the command is a detail beside a button that
 *  runs it, so it can scroll when a card is too narrow to show all of it. */
export function CmdField(props: { text: string }) {
  const [copied, setCopied] = createSignal(false);
  const copy = async () => {
    if (!(await copyText(props.text))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div class={styles.cmdField}>
      <input class={styles.cmdFieldText} readOnly value={props.text} aria-label="Command" spellcheck={false} />
      <IconButton
        size="sm"
        icon={<Icon icon={copied() ? Check : Copy} />}
        tooltip={copied() ? "Copied" : "Copy"}
        aria-label="Copy command"
        onClick={() => void copy()}
      />
    </div>
  );
}

/** A real `input[type=number]`, not the mock's read-only display: a zoom of 200
 *  is a lot of clicking away from its default, and a spinbutton is what a screen
 *  reader should meet here.
 *
 *  Here rather than in `src/components/` because it is sized for the fixed
 *  control column and means nothing outside it. The switch and select beside it
 *  are the shared ones, so this is the only control the kit still owns. */
export function Stepper(props: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  "aria-label": string;
}) {
  let field!: HTMLInputElement;
  const step = () => props.step ?? 1;
  // Fractional steps (line height moves by 0.1) accumulate float noise, so every
  // result is rounded to the step's own precision rather than left at
  // 1.7000000000000002.
  const places = () => (step() < 1 ? 1 : 0);
  const bound = (v: number) => Math.min(props.max, Math.max(props.min, Number(v.toFixed(places()))));

  /** Steps above `min`: the unit both the buttons and the typed field work in. */
  const units = () => (props.value - props.min) / step();

  /** To the next grid point, not `value ± step`: an off-grid 12 with a step of 5
   *  would walk 17 from the button and 15 from the field's own Up arrow. */
  const nudge = (dir: 1 | -1) => {
    const u = units();
    // 1e-9, because (1.5 - 1) / 0.1 is 4.999999999999996 and an on-grid value
    // must not be treated as off-grid.
    const onGrid = Math.abs(u - Math.round(u)) < 1e-9;
    const next = onGrid ? Math.round(u) + dir : dir > 0 ? Math.ceil(u) : Math.floor(u);
    props.onChange(bound(props.min + next * step()));
  };

  /** An entry can resolve to the value already stored (clamped, blank, snapped),
   *  and then nothing re-renders and the field keeps text the setting never
   *  took: 99 typed into a font size at its maximum of 24 stayed on screen. */
  const commit = (raw: string) => {
    const u = (clamp(raw, props.min, props.max, props.value) - props.min) / step();
    const next = bound(props.min + Math.round(u) * step());
    if (next === props.value) field.value = String(next);
    props.onChange(next);
  };

  return (
    <div class={styles.numStepper}>
      <button
        type="button"
        class={styles.stepperBtn}
        aria-label={`Decrease ${props["aria-label"]}`}
        disabled={props.value <= props.min}
        onClick={() => nudge(-1)}
      >
        −
      </button>
      <input
        ref={field}
        type="number"
        class={styles.num}
        min={props.min}
        max={props.max}
        step={step()}
        aria-label={props["aria-label"]}
        value={props.value}
        onChange={(e) => commit(e.currentTarget.value)}
      />
      <button
        type="button"
        class={styles.stepperBtn}
        aria-label={`Increase ${props["aria-label"]}`}
        disabled={props.value >= props.max}
        onClick={() => nudge(1)}
      >
        +
      </button>
    </div>
  );
}

/**
 * One setting on screen: the row, and the explanation under it when it has one.
 *
 * Hidden entirely when a query is running and this entry did not match. The id
 * is the catalogue's, which is the same id the search counts, so a badge saying
 * "3" and a pane showing two rows is not a state this can reach.
 */
export function Row(props: PaneProps & { id: string; label: string; hint?: string; children: JSX.Element }) {
  /** The catalogue's hint unless the pane passed one.
   *
   * The two are allowed to differ - several rows say more on screen than the
   * catalogue needs for searching - but they should not have to be written twice
   * to say the *same* thing, which is a pair that drifts. The prop overrides;
   * silence means "the one already in the catalogue". */
  const hint = () => props.hint ?? SETTINGS.find((s) => s.id === props.id)?.hint;
  return (
    <Show when={props.shown(props.id)}>
      {/* Siblings placed by grid, never nested columns: a wrapper div would lay
          out identically and quietly break `label.closest("div")`, which is how
          the suite reaches every control here. */}
      <div id={rowDomId(props.id)} class={styles.row}>
        <label id={rowLabelId(props.id)} class={styles.label}>
          <MarkedLabel query={props.query} text={props.label} />
        </label>
        <div class={styles.control}>{props.children}</div>
        <Show when={hint()}>
          <div class={styles.hint}>
            <MarkedHint query={props.query} text={hint()!} />
          </div>
        </Show>
      </div>
    </Show>
  );
}

/**
 * A section whose controls only exist at runtime, shown or hidden whole.
 *
 * Agents, language servers, debuggers and GitHub build a card per thing found,
 * so there is no row to mark. The whole group is marked instead - which is also
 * exactly what its single catalogue entry means, and what the badge counted.
 */
export function CardSection(props: PaneProps & { id: string; children: JSX.Element }) {
  const searching = () => props.query.trim() !== "";
  const matched = () => searching() && props.shown(props.id);
  const entry = () => SETTINGS.find((s) => s.id === props.id);
  const tab = () => tabOfEntry(props.id);
  const tabLabel = () => SETTING_TABS.find((t) => t.id === tab())?.label ?? "";
  return (
    <Show when={props.shown(props.id)}>
      {/* The wrapper carries `.cardSection`, not just the hit marker. Wrapping
          the `<section>` makes it `:first-child` of its own div, so the
          `.section:first-child` rule zeroes its top margin and two stacked card
          sections would butt together - the wrapper takes over that rhythm. */}
      <div id={rowDomId(props.id)} classList={{ [styles.cardSection]: true, [styles.cardSectionHit]: matched() }}>
        {/* A result, not the section: a agent grid and a 31-entry catalogue
            unfolding into a list of matching *settings* is the wall this
            redesign removes. So it says where the thing is and offers to go. */}
        <Show when={searching()} fallback={props.children}>
          <div class={styles.row}>
            <label class={styles.label}>
              <MarkedLabel query={props.query} text={entry()?.label ?? props.id} />
            </label>
            <div class={styles.control}>
              <Button size="sm" onClick={() => tab() && props.openTab?.(tab()!)}>
                Open {tabLabel()}
              </Button>
            </div>
            <Show when={entry()?.hint}>
              <div class={styles.hint}>
                <MarkedHint query={props.query} text={entry()!.hint!} />
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
}

/**
 * The row a setting that is not a switch gets: its own control, wearing the
 * badge, the "Set here" action and the hint the checkboxes wear.
 *
 * Generic in the key rather than written once per setting. The control is the
 * only part that differs, and the rest is the part that has to stay identical:
 * a setting that showed one layer and wrote another reads as broken. Generic
 * because the "Set here" write has to hand `setWorkspaceOverride` a value of
 * that key's own type, which a union of keys cannot do.
 */
function EditsRow<K extends Exclude<keyof EditorDefaults, EditorToggleKey>>(
  props: PaneProps & {
    entry: SettingEntry;
    setting: K;
    pin: string;
    children: JSX.Element;
  },
) {
  const fromWorkspace = () => editorOrigin()[props.setting] === "workspace";
  return (
    <Show when={props.shown(props.entry.id)}>
      <div id={rowDomId(props.entry.id)} class={styles.row}>
        <label class={styles.label} id={rowLabelId(props.entry.id)}>
          <MarkedLabel query={props.query} text={props.entry.label} />
        </label>
        <div class={styles.control}>
          <Show when={fromWorkspace()}>
            <span class={styles.originBadge} title={workspaceName()}>
              workspace
            </span>
          </Show>
          {props.children}
          <Show when={overlayRoot()}>
            <Tooltip
              as="button"
              type="button"
              class={styles.originAction}
              onClick={() =>
                void setWorkspaceOverride(props.setting, fromWorkspace() ? undefined : editorDefaults()[props.setting])
              }
              label={fromWorkspace() ? "Stop overriding this here and follow your global setting again" : props.pin}
            >
              {fromWorkspace() ? "Clear" : "Set here"}
            </Tooltip>
          </Show>
        </div>
        <Show when={props.entry.hint}>
          <div class={styles.hint}>
            <MarkedHint query={props.query} text={props.entry.hint!} />
          </div>
        </Show>
      </div>
    </Show>
  );
}

/** The TODO tags row: a text box where the rest of the group has checkboxes. */
export function TodoTagsRow(props: PaneProps) {
  return (
    <EditsRow
      {...props}
      entry={TODO_TAGS}
      setting="todoPatterns"
      pin="Pin these tags for this workspace only, leaving your global setting alone"
    >
      <input
        class={`${styles.input} ${styles.text}`}
        aria-label={TODO_TAGS.label}
        value={editorDefaults().todoPatterns}
        onChange={(e) => setEditorDefault("todoPatterns", e.currentTarget.value)}
      />
    </EditsRow>
  );
}

/** The tab size row: a stepper, since a width has no other value to flip to. */
export function TabSizeRow(props: PaneProps) {
  return (
    <EditsRow
      {...props}
      entry={TAB_SIZE}
      setting="tabSize"
      pin="Use this width in the current workspace only, leaving your global setting alone"
    >
      <Stepper
        aria-label={TAB_SIZE.label}
        min={1}
        max={8}
        value={editorDefaults().tabSize}
        onChange={(v) => setEditorDefault("tabSize", v)}
      />
    </EditsRow>
  );
}

/** Where the caret's line is marked: a dropdown, because four answers do not
 *  fit a checkbox. The labels say the place rather than VS Code's value names,
 *  which are only legible next to the setting's own title. */
const ACTIVE_LINE_OPTIONS: SelectOption[] = [
  { value: "none", label: "Nowhere" },
  { value: "gutter", label: "Gutter only" },
  { value: "line", label: "The line" },
  { value: "all", label: "Gutter and line" },
];

export function ActiveLineRow(props: PaneProps) {
  return (
    <EditsRow
      {...props}
      entry={ACTIVE_LINE}
      setting="activeLineHighlight"
      pin="Use this in the current workspace only, leaving your global setting alone"
    >
      <Select
        options={ACTIVE_LINE_OPTIONS}
        value={editorDefaults().activeLineHighlight}
        onChange={(v) => setEditorDefault("activeLineHighlight", v as ActiveLineHighlight)}
        aria-labelledby={rowLabelId(ACTIVE_LINE.id)}
      />
    </EditsRow>
  );
}

/**
 * One boolean row: the badge, the checkbox, and the per-workspace action.
 *
 * All three read and write whichever layer is in force. Showing one layer and
 * writing another is the failure this shape exists to prevent: a click that
 * changed a value the row was not displaying reads as the toggle being broken.
 * The write goes through `setEditorDefault`, which the palette's `Preferences:
 * ...` commands share, so the two surfaces cannot land in different layers.
 */
export function ToggleRow(props: PaneProps & { entry: EditorToggle }) {
  const key = () => props.entry.key;
  const fromWorkspace = () => editorOrigin()[key()] === "workspace";
  return (
    <Show when={props.shown(props.entry.id)}>
      <div id={rowDomId(props.entry.id)} class={styles.row}>
        <label class={styles.label}>
          <MarkedLabel query={props.query} text={props.entry.label} />
        </label>
        <div class={styles.control}>
          {/* Only where the overlay actually supplies the value. "user" and
              "default" are the ordinary case and would be a badge on almost
              every row, which says nothing. */}
          <Show when={fromWorkspace()}>
            <span class={styles.originBadge} title={workspaceName()}>
              workspace
            </span>
          </Show>
          {/* The row's own `<label>` is chrome rather than a form label (it wraps
              nothing and carries the search highlighting), so the control names
              itself from the entry. */}
          <Switch
            checked={editorDefaults()[key()]}
            aria-label={props.entry.label}
            onChange={(v) => setEditorDefault(key(), v)}
          />
          <Show when={overlayRoot()}>
            <Tooltip
              as="button"
              type="button"
              class={styles.originAction}
              onClick={() => void setWorkspaceOverride(key(), fromWorkspace() ? undefined : editorDefaults()[key()])}
              label={
                fromWorkspace()
                  ? "Stop overriding this here and follow your global setting again"
                  : "Pin this setting for this workspace only, leaving your global setting alone"
              }
            >
              {fromWorkspace() ? "Clear" : "Set here"}
            </Tooltip>
          </Show>
        </div>
        <Show when={props.entry.hint}>
          <div class={styles.hint}>
            <MarkedHint query={props.query} text={props.entry.hint!} />
          </div>
        </Show>
      </div>
    </Show>
  );
}

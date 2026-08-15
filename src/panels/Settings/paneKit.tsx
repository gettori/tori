// The parts every settings pane is built from: the row primitives, the writers
// that go through `saveSettings`, and the coercion the number fields need.
//
// All of this lived inside `Settings.tsx`'s component closure until the panel
// became six panes, and six components cannot share one closure. Nothing here
// closes over anything per-render - only over the imported store - so the move
// was a move rather than a rewrite.
import { For, Show, type JSX } from "solid-js";
import { hintRanges, labelRanges, segments, type Range } from "./searchHighlight";
import {
  SETTINGS,
  type SettingEntry,
  type SettingSection,
  type EditorToggleKey,
} from "../../utils/settingsCatalog";
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
  type Harness,
  type Typography,
} from "./settingsStore";
import styles from "./Settings.module.css";
import Tooltip from "../../components/Tooltip/Tooltip";

// Font inputs show only the primary family; the app's fallback stack is kept
// out of the field and re-attached on save, so a user types "JetBrains Mono"
// rather than editing a whole CSS list (and never accidentally drops the
// system fallbacks). One stack per surface.
export const UI_FONT_FALLBACK =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';
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
export const setCheckpoints = (c: Partial<Checkpoints>) =>
  saveSettings({ ...settings, checkpoints: { ...settings.checkpoints, ...c } });
export const setChatDefaults = (c: Partial<ChatDefaults>) =>
  saveSettings({ ...settings, chatDefaults: { ...settings.chatDefaults, ...c } });
export const setBudgets = (b: Partial<Budgets>) =>
  saveSettings({ ...settings, budgets: { ...settings.budgets, ...b } });
export const setHarness = (h: Partial<Harness>) =>
  saveSettings({ ...settings, harness: { ...settings.harness, ...h } });

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

/** The one editing setting that is not a switch, read off the catalogue like
 *  the toggles are so its label and hint are still named in one place. Found by
 *  the key it edits rather than by its id, so the row and the setting cannot
 *  drift apart the way two strings can. */
export const TODO_TAGS: SettingEntry = SETTINGS.find((s) => s.edits === "todoPatterns")!;

/** What a pane needs from the shell: which rows the query left on screen, and
 *  the query itself so a row can mark *why* it is one of them. `shown` answers
 *  true for everything when nothing is typed, so a pane never has to ask whether
 *  a search is running; `query` is `""` then, which marks nothing. */
export type PaneProps = { shown: (id: string) => boolean; query: string };

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
  children: JSX.Element;
}) {
  return (
    <Show when={props.ids.some((id) => props.shown(id))}>
      <section class={styles.section}>
        <div class={styles.sectionTitle}>{props.title}</div>
        {props.children}
      </section>
    </Show>
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
      <div id={rowDomId(props.id)} class={styles.row}>
        <label id={rowLabelId(props.id)} class={styles.label}>
          <MarkedLabel query={props.query} text={props.label} />
        </label>
        {props.children}
      </div>
      <Show when={hint()}>
        <div class={styles.hint}>
          <MarkedHint query={props.query} text={hint()!} />
        </div>
      </Show>
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
  const matched = () => props.query.trim() !== "" && props.shown(props.id);
  return (
    <Show when={props.shown(props.id)}>
      {/* The wrapper carries `.cardSection`, not just the hit marker. Wrapping
          the `<section>` makes it `:first-child` of its own div, so the
          `.section:first-child` rule zeroes its top margin and two stacked card
          sections would butt together - the wrapper takes over that rhythm. */}
      <div
        id={rowDomId(props.id)}
        classList={{ [styles.cardSection]: true, [styles.cardSectionHit]: matched() }}
      >
        {props.children}
      </div>
    </Show>
  );
}

/**
 * The TODO tags row: a text box where the rest of the group has checkboxes.
 *
 * Written out rather than folded into `ToggleRow` because only the control
 * differs; the badge, the "Set here" action and the layer they read are the
 * same, and they are the part that has to stay identical. A setting that showed
 * one layer and wrote another would read as broken here exactly as it would
 * there.
 */
export function TodoTagsRow(props: PaneProps) {
  const fromWorkspace = () => editorOrigin().todoPatterns === "workspace";
  return (
    <Show when={props.shown(TODO_TAGS.id)}>
      <div id={rowDomId(TODO_TAGS.id)} class={styles.row}>
        <label class={styles.label}>
          <MarkedLabel query={props.query} text={TODO_TAGS.label} />
        </label>
        <Show when={fromWorkspace()}>
          <span class={styles.originBadge} title={workspaceName()}>
            workspace
          </span>
        </Show>
        <input
          class={`${styles.input} ${styles.text}`}
          aria-label={TODO_TAGS.label}
          value={editorDefaults().todoPatterns}
          onChange={(e) => setEditorDefault("todoPatterns", e.currentTarget.value)}
        />
        <Show when={overlayRoot()}>
          <Tooltip
            as="button"
            type="button"
            class={styles.originAction}
            onClick={() =>
              void setWorkspaceOverride(
                "todoPatterns",
                fromWorkspace() ? undefined : editorDefaults().todoPatterns,
              )
            }
            label={
              fromWorkspace()
                ? "Stop overriding this here and follow your global setting again"
                : "Pin these tags for this workspace only, leaving your global setting alone"
            }
          >
            {fromWorkspace() ? "Clear" : "Set here"}
          </Tooltip>
        </Show>
      </div>
      <Show when={TODO_TAGS.hint}>
        <div class={styles.hint}>
          <MarkedHint query={props.query} text={TODO_TAGS.hint!} />
        </div>
      </Show>
    </Show>
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
        {/* Only where the overlay actually supplies the value. "user" and
            "default" are the ordinary case and would be a badge on almost every
            row, which says nothing. */}
        <Show when={fromWorkspace()}>
          <span class={styles.originBadge} title={workspaceName()}>
            workspace
          </span>
        </Show>
        <input
          type="checkbox"
          checked={editorDefaults()[key()]}
          onChange={(e) => setEditorDefault(key(), e.currentTarget.checked)}
        />
        <Show when={overlayRoot()}>
          <Tooltip
            as="button"
            type="button"
            class={styles.originAction}
            onClick={() =>
              void setWorkspaceOverride(key(), fromWorkspace() ? undefined : editorDefaults()[key()])
            }
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
    </Show>
  );
}

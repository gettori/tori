import { createEffect, createMemo, createSignal, on, onMount, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import AgentsSection from "./AgentsSection";
import GithubSection from "./GithubSection";
import LspSection from "./LspSection";
import DapSection from "./DapSection";
import { matchingSections } from "./settingsSearch";
import { SETTINGS, type SettingSection, type EditorToggleKey } from "../../utils/settingsCatalog";
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
  type DefaultSurface,
  type Harness,
  type TranscriptDensity,
  type Typography,
} from "./settingsStore";
import { listSelectableThemes, DEFAULT_THEME_ID } from "../../theme";
import { primaryFamily } from "../../utils/fontLoad";
import Button from "../../components/Button/Button";
import styles from "./Settings.module.css";

// Font inputs show only the primary family; the app's fallback stack is kept
// out of the field and re-attached on save, so a user types "JetBrains Mono"
// rather than editing a whole CSS list (and never accidentally drops the
// system fallbacks). One stack per surface.
const UI_FONT_FALLBACK = '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';
const EDITOR_FONT_FALLBACK = "Menlo, Monaco, monospace";
const TERMINAL_FONT_FALLBACK = "Menlo, Monaco, monospace";

// `primaryFamily` (the first family in a stack, unquoted, which is what this
// input shows) is shared with the terminal's font-load wait: both have to read
// a stack the same way, and two parsers would eventually disagree about one
// with quotes in it.

/** Rebuild a full stack from a user-entered primary name plus the surface's
 *  fallbacks. A blank entry falls back to the stack alone (no leading comma).
 *  Names with spaces are quoted so the CSS value stays valid. */
function withFallback(primary: string, fallback: string): string {
  const name = primary.trim();
  if (!name) return fallback;
  const quoted = /\s/.test(name) ? `"${name}"` : name;
  return `${quoted}, ${fallback}`;
}

type EditorToggle = { key: EditorToggleKey; label: string; hint?: string };

/** The boolean editor rows of one section, read off the catalogue so a setting
 *  is named in exactly one place (see `utils/settingsCatalog.ts`). */
function togglesIn(section: SettingSection): EditorToggle[] {
  return SETTINGS.filter((s) => s.section === section && s.toggles).map((s) => ({
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
 *  Their own section above the list, because each needs a paragraph the rest do
 *  not. */
const OWN_ROW_TOGGLES = togglesIn("editor");

/** The one editing setting that is not a switch, read off the catalogue like
 *  the toggles are so its label and hint are still named in one place. Found by
 *  the key it edits rather than by its id, so the row and the setting cannot
 *  drift apart the way two strings can. */
const TODO_TAGS = SETTINGS.find((s) => s.edits === "todoPatterns")!;

/**
 * The TODO tags row: a text box where the rest of the section has checkboxes.
 *
 * Written out rather than folded into `ToggleRow` because only the control
 * differs; the badge, the "Set here" action and the layer they read are the
 * same, and they are the part that has to stay identical. A setting that showed
 * one layer and wrote another would read as broken here exactly as it would
 * there.
 */
function TodoTagsRow(props: { workspaceName: string }) {
  const fromWorkspace = () => editorOrigin().todoPatterns === "workspace";
  return (
    <>
      <div class={styles.row}>
        <label class={styles.label}>{TODO_TAGS.label}</label>
        <Show when={fromWorkspace()}>
          <span class={styles.originBadge} title={props.workspaceName}>
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
          <button
            class={styles.originAction}
            onClick={() =>
              void setWorkspaceOverride(
                "todoPatterns",
                fromWorkspace() ? undefined : editorDefaults().todoPatterns,
              )
            }
            title={
              fromWorkspace()
                ? "Stop overriding this here and follow your global setting again"
                : "Pin these tags for this workspace only, leaving your global setting alone"
            }
          >
            {fromWorkspace() ? "Clear" : "Set here"}
          </button>
        </Show>
      </div>
      <Show when={TODO_TAGS.hint}>
        <div class={styles.hint}>{TODO_TAGS.hint}</div>
      </Show>
    </>
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
function ToggleRow(props: { entry: EditorToggle; workspaceName: string }) {
  const key = () => props.entry.key;
  const fromWorkspace = () => editorOrigin()[key()] === "workspace";
  return (
    <>
      <div class={styles.row}>
        <label class={styles.label}>{props.entry.label}</label>
        {/* Only where the overlay actually supplies the value. "user" and
            "default" are the ordinary case and would be a badge on almost every
            row, which says nothing. */}
        <Show when={fromWorkspace()}>
          <span class={styles.originBadge} title={props.workspaceName}>
            workspace
          </span>
        </Show>
        <input
          type="checkbox"
          checked={editorDefaults()[key()]}
          onChange={(e) => setEditorDefault(key(), e.currentTarget.checked)}
        />
        <Show when={overlayRoot()}>
          <button
            class={styles.originAction}
            onClick={() =>
              void setWorkspaceOverride(key(), fromWorkspace() ? undefined : editorDefaults()[key()])
            }
            title={
              fromWorkspace()
                ? "Stop overriding this here and follow your global setting again"
                : "Pin this setting for this workspace only, leaving your global setting alone"
            }
          >
            {fromWorkspace() ? "Clear" : "Set here"}
          </button>
        </Show>
      </div>
      <Show when={props.entry.hint}>
        <div class={styles.hint}>{props.entry.hint}</div>
      </Show>
    </>
  );
}

// The in-app settings screen. Reads the reactive settings store and writes back
// through saveSettings (which persists to settings.json and applies live). A
// portaled overlay like the other modals: Escape / backdrop click closes, the
// first control takes focus on open.
export default function Settings(props: { onClose: () => void; welcome?: boolean; query?: string }) {
  let firstControl: HTMLInputElement | undefined;
  onMount(() => requestAnimationFrame(() => firstControl?.focus()));

  /** The filter box. Seeded from the prop rather than bound to it, because a
   *  `Preferences: ...` command opens the panel *at* a setting and the user has
   *  to be able to type past it the moment it lands. */
  const [query, setQuery] = createSignal(props.query ?? "");
  // A later command re-filters a panel that is already open. ⌘K reaches the
  // palette over this modal, and opening an open panel remounts nothing, so
  // without this the row would close the palette and appear to do nothing.
  // Deferred, so it is only a *change* of prop that overwrites what is typed.
  createEffect(on(() => props.query, (q) => setQuery(q ?? ""), { defer: true }));
  const shown = createMemo(() => matchingSections(query()));
  const show = (section: SettingSection) => {
    const only = shown();
    return !only || only.has(section);
  };

  /** The workspace an override would be written to, by its folder name. The
   *  editor pane owns which workspace is selected; this panel reads it rather
   *  than taking a prop, since it is opened from the top bar and from the
   *  palette and neither of those knows. */
  const workspaceName = () => overlayRoot()?.split("/").pop() ?? "";

  const setAppearance = (a: Partial<Appearance>) =>
    saveSettings({ ...settings, appearance: { ...settings.appearance, ...a } });
  const setTypography = (t: Partial<Typography>) =>
    saveSettings({ ...settings, typography: { ...settings.typography, ...t } });
  const setCheckpoints = (c: Partial<Checkpoints>) =>
    saveSettings({ ...settings, checkpoints: { ...settings.checkpoints, ...c } });
  const setChatDefaults = (c: Partial<ChatDefaults>) =>
    saveSettings({ ...settings, chatDefaults: { ...settings.chatDefaults, ...c } });
  const setBudgets = (b: Partial<Budgets>) =>
    saveSettings({ ...settings, budgets: { ...settings.budgets, ...b } });
  // A ceiling is opt-in, so a blank field is the *unset* value rather than an
  // invalid one. `clamp` cannot express that: it falls back to the previous
  // value, which would make a ceiling impossible to clear once set.
  const optionalNumber = (v: string, min: number): number | null => {
    if (v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? n : null;
  };
  const setHarness = (h: Partial<Harness>) =>
    saveSettings({ ...settings, harness: { ...settings.harness, ...h } });

  // Reject empty/NaN/out-of-range commits (a blank or 0 font size would blank
  // the UI); fall back to the current value so an invalid entry is a no-op.
  const clamp = (v: string, min: number, max: number, fallback: number) => {
    const n = Number(v);
    if (v.trim() === "" || !Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };

  // One memo, split into the two groups the picker renders. The list folds the
  // bundled set together with whatever is in the themes folder, so rebuilding it
  // per <For> would do that work four times for one render.
  const themes = createMemo(() => listSelectableThemes());
  const bundledThemes = createMemo(() => themes().filter((t) => t.source === "bundled"));
  const userThemes = createMemo(() => themes().filter((t) => t.source !== "bundled"));

  // The registry falls back to the default for an id it does not know, so the
  // picker has to show what is actually painted. Binding the stored id directly
  // renders the select *blank* whenever settings.json names a theme that no
  // longer exists, which reads as "no theme" rather than "that one is gone".
  const currentTheme = () =>
    themes().some((t) => t.id === settings.appearance.theme) ? settings.appearance.theme : DEFAULT_THEME_ID;

  return (
    <Portal>
      <div class={styles.backdrop} onMouseDown={() => props.onClose()}>
        <div
          class={styles.panel}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), props.onClose())}
        >
          <div class={styles.header}>
            <div class={styles.title}>Settings</div>
            <Button variant="ghost" size="xs" aria-label="Close" title="Close" onClick={() => props.onClose()}>
              ×
            </Button>
          </div>

          <div class={styles.body}>
            {/* Agents leads the panel: it is the section first-run opens onto,
                and the one answering "will this work with my setup?". */}
            <Show when={props.welcome}>
              <div class={styles.welcome}>
                Welcome to Sway. It drives the agent CLIs you already have, so start by
                checking which ones it found below, then open a folder in the sidebar to
                begin a session.
              </div>
            </Show>
            {/* Above the sections, not inside one: it is the way through them
                rather than one more thing to set. */}
            <input
              ref={firstControl}
              class={`${styles.input} ${styles.search}`}
              type="search"
              aria-label="Search settings"
              placeholder="Search settings"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
            <Show when={shown()?.size === 0}>
              <div class={styles.hint}>No setting matches “{query().trim()}”.</div>
            </Show>

            <Show when={show("agents")}>
              <AgentsSection />
            </Show>
            <Show when={show("lsp")}>
              <LspSection />
            </Show>
            <Show when={show("dap")}>
              <DapSection />
            </Show>
            <Show when={show("github")}>
              <GithubSection />
            </Show>

            <Show when={show("appearance")}>
              <section class={styles.section}>
                <div class={styles.sectionTitle}>Appearance</div>
                <div class={styles.row}>
                  <label class={styles.label}>Theme</label>
                  <div class={styles.control}>
                    <select
                      class={styles.select}
                      value={currentTheme()}
                      onChange={(e) => setAppearance({ theme: e.currentTarget.value })}
                    >
                      {/* Grouped by source so a user theme is visibly not one of
                          Sway's, and a file dropped in the folder is visibly the
                          thing that appeared. The user group is omitted entirely
                          when the folder is empty, rather than shown empty. */}
                      <optgroup label="Bundled">
                        <For each={bundledThemes()}>{(t) => <option value={t.id}>{t.label}</option>}</For>
                      </optgroup>
                      <Show when={userThemes().length > 0}>
                        <optgroup label="From ~/.config/sway/themes">
                          <For each={userThemes()}>{(t) => <option value={t.id}>{t.label}</option>}</For>
                        </optgroup>
                      </Show>
                    </select>
                  </div>
                </div>
              </section>
            </Show>

            <Show when={show("typography")}>
              <section class={styles.section}>
                <div class={styles.sectionTitle}>Typography</div>
                <div class={styles.row}>
                  <label class={styles.label}>UI font family</label>
                  <input
                    class={`${styles.input} ${styles.text}`}
                    value={primaryFamily(settings.typography.uiFontFamily)}
                    onChange={(e) =>
                      setTypography({ uiFontFamily: withFallback(e.currentTarget.value, UI_FONT_FALLBACK) })
                    }
                  />
                </div>
                <div class={styles.row}>
                  <label class={styles.label}>UI font size</label>
                  <input
                    type="number"
                    min="9"
                    max="24"
                    class={`${styles.input} ${styles.num}`}
                    value={settings.typography.uiFontSize}
                    onChange={(e) =>
                      setTypography({ uiFontSize: clamp(e.currentTarget.value, 9, 24, settings.typography.uiFontSize) })
                    }
                  />
                </div>
                <div class={styles.row}>
                  <label class={styles.label}>Editor font family</label>
                  <input
                    class={`${styles.input} ${styles.text}`}
                    value={primaryFamily(settings.typography.editorFontFamily)}
                    onChange={(e) =>
                      setTypography({ editorFontFamily: withFallback(e.currentTarget.value, EDITOR_FONT_FALLBACK) })
                    }
                  />
                </div>
                <div class={styles.row}>
                  <label class={styles.label}>Editor font size</label>
                  <input
                    type="number"
                    min="9"
                    max="24"
                    class={`${styles.input} ${styles.num}`}
                    value={settings.typography.editorFontSize}
                    onChange={(e) =>
                      setTypography({ editorFontSize: clamp(e.currentTarget.value, 9, 24, settings.typography.editorFontSize) })
                    }
                  />
                </div>
                <div class={styles.row}>
                  <label class={styles.label}>Terminal font family</label>
                  <input
                    class={`${styles.input} ${styles.text}`}
                    value={primaryFamily(settings.typography.terminalFontFamily)}
                    onChange={(e) =>
                      setTypography({
                        terminalFontFamily: withFallback(e.currentTarget.value, TERMINAL_FONT_FALLBACK),
                      })
                    }
                  />
                </div>
                {/* Worth naming: it is the one family here that needs no install,
                    and its exact spelling is not guessable. */}
                <div class={styles.hint}>
                  JetBrainsMono Nerd Font Mono ships with Sway, so its icon glyphs render without a
                  font install. Any family on this machine works too.
                </div>
                <div class={styles.row}>
                  <label class={styles.label}>Terminal font size</label>
                  <input
                    type="number"
                    min="9"
                    max="24"
                    class={`${styles.input} ${styles.num}`}
                    value={settings.typography.terminalFontSize}
                    onChange={(e) =>
                      setTypography({ terminalFontSize: clamp(e.currentTarget.value, 9, 24, settings.typography.terminalFontSize) })
                    }
                  />
                </div>
                <div class={styles.row}>
                  <label class={styles.label}>Line height</label>
                  <input
                    type="number"
                    min="1"
                    max="2.5"
                    step="0.1"
                    class={`${styles.input} ${styles.num}`}
                    value={settings.typography.lineHeight}
                    onChange={(e) =>
                      setTypography({ lineHeight: clamp(e.currentTarget.value, 1, 2.5, settings.typography.lineHeight) })
                    }
                  />
                </div>
              </section>
            </Show>

            <Show when={show("editor")}>
              <section class={styles.section}>
                <div class={styles.sectionTitle}>Editor</div>
                {/* The same row as the comfort list below, so these two answer to
                    the workspace overlay as well: before they did, the palette's
                    “Preferences: Vim keybindings” wrote the layer in force while
                    this row wrote and showed the global one, and a workspace that
                    overrode either made the pair disagree on screen. */}
                <For each={OWN_ROW_TOGGLES}>
                  {(t) => <ToggleRow entry={t} workspaceName={workspaceName()} />}
                </For>
              </section>
            </Show>

            <Show when={show("checkpoints")}>
              <section class={styles.section}>
                <div class={styles.sectionTitle}>Checkpoints</div>
                <div class={styles.row}>
                  <label class={styles.label}>Snapshot on each prompt</label>
                  <input
                    type="checkbox"
                    checked={settings.checkpoints.enabled}
                    onChange={(e) => setCheckpoints({ enabled: e.currentTarget.checked })}
                  />
                </div>
                <div class={styles.hint}>
                  Lets a session's turns be diffed and reverted. Adds one git snapshot per prompt.
                </div>
              </section>
            </Show>

            <Show when={show("editing")}>
              <section class={styles.section}>
                <div class={styles.sectionTitle}>Editor</div>
                {/* Data-driven rather than ten hand-written rows: every one of
                    these is the same boolean row, and the list is what the wave
                    keeps adding to. The hint is optional, carried only by the
                    keys whose effect is not obvious from the label. */}
                <For each={EDITOR_TOGGLES}>
                  {(t) => <ToggleRow entry={t} workspaceName={workspaceName()} />}
                </For>
                <TodoTagsRow workspaceName={workspaceName()} />
                <Show
                  when={overlayRoot()}
                  fallback={<div class={styles.hint}>Select a branch to override any of these for one workspace.</div>}
                >
                  <div class={styles.hint}>
                    “Set here” writes to {workspaceName()}/.sway/settings.json, which stays on this machine: Sway adds
                    it to the repo's own ignore list, so it never reaches a commit or a teammate.
                  </div>
                </Show>
              </section>
            </Show>

            <Show when={show("chat")}>
              <section class={styles.section}>
                <div class={styles.sectionTitle}>Chat</div>

                <div class={styles.row}>
                  <label class={styles.label}>Open sessions in</label>
                  <div class={styles.control}>
                    <select
                      class={styles.select}
                      value={settings.chatDefaults.defaultSurface}
                      onChange={(e) => setChatDefaults({ defaultSurface: e.currentTarget.value as DefaultSurface })}
                    >
                      <option value="chat">Chat</option>
                      <option value="agent">Terminal (agent tab)</option>
                    </select>
                  </div>
                </div>
                <div class={styles.hint}>
                  Which surface a click on a session opens. The other one stays available from the
                  split-button menu either way, and already-saved tabs reopen on the surface they were
                  saved on.
                </div>

                {/* No default model/effort/mode settings on purpose: a new chat
                    opens on whatever the CLI itself would choose, and the
                    composer's pickers change course mid-conversation. */}

                <div class={styles.row}>
                  <label class={styles.label}>Stream responses</label>
                  <input
                    type="checkbox"
                    checked={settings.chatDefaults.streaming}
                    onChange={(e) => setChatDefaults({ streaming: e.currentTarget.checked })}
                  />
                </div>

                <div class={styles.row}>
                  <label class={styles.label}>Transcript density</label>
                  <div class={styles.control}>
                    <select
                      class={styles.select}
                      value={settings.chatDefaults.density}
                      onChange={(e) => setChatDefaults({ density: e.currentTarget.value as TranscriptDensity })}
                    >
                      <option value="comfortable">Comfortable</option>
                      <option value="compact">Compact</option>
                    </select>
                  </div>
                </div>

                <div class={styles.row}>
                  <label class={styles.label}>Tool output lines</label>
                  <input
                    type="number"
                    min="0"
                    max="500"
                    class={`${styles.input} ${styles.num}`}
                    value={settings.chatDefaults.toolOutputLines}
                    onChange={(e) =>
                      setChatDefaults({
                        toolOutputLines: clamp(e.currentTarget.value, 0, 500, settings.chatDefaults.toolOutputLines),
                      })
                    }
                  />
                </div>
                <div class={styles.hint}>Lines shown before a tool's output folds. 0 shows all of it.</div>

                <div class={styles.row}>
                  <label class={styles.label}>Auto-deny approvals after</label>
                  <input
                    type="number"
                    min="5"
                    max="3600"
                    class={`${styles.input} ${styles.num}`}
                    value={settings.chatDefaults.approvalAutoDenySecs}
                    onChange={(e) =>
                      setChatDefaults({
                        approvalAutoDenySecs: clamp(
                          e.currentTarget.value,
                          5,
                          3600,
                          settings.chatDefaults.approvalAutoDenySecs,
                        ),
                      })
                    }
                  />
                </div>
                <div class={styles.hint}>
                  Seconds an unanswered tool approval waits before Sway denies it. Sway owns this
                  timeout so it always fires before the harness's own.
                </div>

                <div class={styles.row}>
                  <label class={styles.label}>Stop this chat after</label>
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    placeholder="no limit"
                    class={`${styles.input} ${styles.num}`}
                    value={settings.budgets.sessionUsd ?? ""}
                    onChange={(e) => setBudgets({ sessionUsd: optionalNumber(e.currentTarget.value, 0) })}
                  />
                </div>
                <div class={styles.hint}>
                  Dollars one chat may spend before it stops at its next tool call. Leave blank for no
                  limit, which is the default.
                </div>

                <div class={styles.row}>
                  <label class={styles.label}>Stop this project after</label>
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    placeholder="no limit"
                    class={`${styles.input} ${styles.num}`}
                    value={settings.budgets.projectUsd ?? ""}
                    onChange={(e) => setBudgets({ projectUsd: optionalNumber(e.currentTarget.value, 0) })}
                  />
                </div>
                <div class={styles.hint}>
                  Dollars across every chat in one project. Two chats open on one repo spend one
                  budget.
                </div>

                <div class={styles.row}>
                  <label class={styles.label}>Stop at context</label>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    placeholder="no limit"
                    class={`${styles.input} ${styles.num}`}
                    value={settings.budgets.contextPercent ?? ""}
                    onChange={(e) => setBudgets({ contextPercent: optionalNumber(e.currentTarget.value, 1) })}
                  />
                </div>
                <div class={styles.hint}>
                  Percent of the model's context window. Unlike the money limits this one recovers on
                  its own after a compaction.
                </div>

                <div class={styles.row}>
                  <label class={styles.label}>Show every hook event</label>
                  <input
                    type="checkbox"
                    checked={settings.chatDefaults.showSwayHooks}
                    onChange={(e) => setChatDefaults({ showSwayHooks: e.currentTarget.checked })}
                  />
                </div>
                <div class={styles.hint}>
                  Off, the transcript shows a hook only when it fails; a hook that ran as configured is
                  not news. On reveals every execution, Sway's own per-tool-call approval hook included.
                </div>
              </section>
            </Show>

            <Show when={show("harness")}>
              <section class={styles.section}>
                <div class={styles.sectionTitle}>Harness</div>
                <div class={styles.row}>
                  <label class={styles.label}>Binary path</label>
                  <input
                    class={`${styles.input} ${styles.text}`}
                    value={settings.harness.path ?? ""}
                    placeholder="found on your login shell's PATH"
                    onChange={(e) => setHarness({ path: e.currentTarget.value.trim() || null })}
                  />
                </div>
                <div class={styles.hint}>
                  Overrides the discovered binary for new chat sessions. Leave it empty to use the one
                  found above. The detected version and any drift from what Sway's adapter was built
                  against are shown in Agents.
                </div>
              </section>
            </Show>
          </div>
        </div>
      </div>
    </Portal>
  );
}

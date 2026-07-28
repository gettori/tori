import { createMemo, onMount, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import AgentsSection from "./AgentsSection";
import {
  settings,
  saveSettings,
  type Appearance,
  type ChatDefaults,
  type Checkpoints,
  type DefaultSurface,
  type Harness,
  type TranscriptDensity,
  type Typography,
} from "./settingsStore";
import { listSelectableThemes, DEFAULT_THEME_ID } from "../../theme";
import Button from "../../components/Button/Button";
import styles from "./Settings.module.css";

// Font inputs show only the primary family; the app's fallback stack is kept
// out of the field and re-attached on save, so a user types "JetBrains Mono"
// rather than editing a whole CSS list (and never accidentally drops the
// system fallbacks). One stack per surface.
const UI_FONT_FALLBACK = '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';
const EDITOR_FONT_FALLBACK = "Menlo, Monaco, monospace";
const TERMINAL_FONT_FALLBACK = "Menlo, Monaco, monospace";

/** The first family in a CSS font stack, unquoted, for display in the input. */
function primaryFamily(stack: string): string {
  const first = stack.split(",")[0]?.trim() ?? "";
  return first.replace(/^["']|["']$/g, "");
}

/** Rebuild a full stack from a user-entered primary name plus the surface's
 *  fallbacks. A blank entry falls back to the stack alone (no leading comma).
 *  Names with spaces are quoted so the CSS value stays valid. */
function withFallback(primary: string, fallback: string): string {
  const name = primary.trim();
  if (!name) return fallback;
  const quoted = /\s/.test(name) ? `"${name}"` : name;
  return `${quoted}, ${fallback}`;
}

// The in-app settings screen. Reads the reactive settings store and writes back
// through saveSettings (which persists to settings.json and applies live). A
// portaled overlay like the other modals: Escape / backdrop click closes, the
// first control takes focus on open.
export default function Settings(props: { onClose: () => void; welcome?: boolean }) {
  let firstControl: HTMLSelectElement | undefined;
  onMount(() => requestAnimationFrame(() => firstControl?.focus()));

  const setAppearance = (a: Partial<Appearance>) =>
    saveSettings({ ...settings, appearance: { ...settings.appearance, ...a } });
  const setTypography = (t: Partial<Typography>) =>
    saveSettings({ ...settings, typography: { ...settings.typography, ...t } });
  const setCheckpoints = (c: Partial<Checkpoints>) =>
    saveSettings({ ...settings, checkpoints: { ...settings.checkpoints, ...c } });
  const setChatDefaults = (c: Partial<ChatDefaults>) =>
    saveSettings({ ...settings, chatDefaults: { ...settings.chatDefaults, ...c } });
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
            <AgentsSection />

            <section class={styles.section}>
              <div class={styles.sectionTitle}>Appearance</div>
              <div class={styles.row}>
                <label class={styles.label}>Theme</label>
                <div class={styles.control}>
                  <select
                    ref={firstControl}
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

              <div class={styles.row}>
                <label class={styles.label}>Default model</label>
                <input
                  class={`${styles.input} ${styles.text}`}
                  value={settings.chatDefaults.model ?? ""}
                  placeholder="the harness default"
                  onChange={(e) => setChatDefaults({ model: e.currentTarget.value.trim() || null })}
                />
              </div>

              <div class={styles.row}>
                <label class={styles.label}>Default effort</label>
                <div class={styles.control}>
                  <select
                    class={styles.select}
                    value={settings.chatDefaults.effort ?? ""}
                    onChange={(e) => setChatDefaults({ effort: e.currentTarget.value || null })}
                  >
                    <option value="">The harness default</option>
                    <For each={["low", "medium", "high", "xhigh", "max"]}>
                      {(level) => <option value={level}>{level}</option>}
                    </For>
                  </select>
                </div>
              </div>

              <div class={styles.row}>
                <label class={styles.label}>Default mode</label>
                <div class={styles.control}>
                  <select
                    class={styles.select}
                    value={settings.chatDefaults.mode ?? ""}
                    onChange={(e) => setChatDefaults({ mode: e.currentTarget.value || null })}
                  >
                    <option value="">The harness default</option>
                    <option value="default">Ask</option>
                    <option value="acceptEdits">Accept edits</option>
                    <option value="plan">Plan</option>
                    <option value="bypassPermissions">Bypass</option>
                  </select>
                </div>
              </div>
              <div class={styles.hint}>
                What a new chat starts with. A project that already has its own remembered picks
                keeps them.
              </div>

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
                <label class={styles.label}>Show Sway's approval hook</label>
                <input
                  type="checkbox"
                  checked={settings.chatDefaults.showSwayHooks}
                  onChange={(e) => setChatDefaults({ showSwayHooks: e.currentTarget.checked })}
                />
              </div>
              <div class={styles.hint}>
                Sway's own hook runs on every tool call and adds two transcript rows each time, so it
                is folded away by default. Your own hooks always show.
              </div>
            </section>

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
          </div>
        </div>
      </div>
    </Portal>
  );
}

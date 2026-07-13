import { onMount, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";
import { settings, saveSettings, type Appearance, type Typography, type Layout } from "./settingsStore";
import { listSelectableThemes } from "../../theme";
import Button from "../../components/Button/Button";
import styles from "./Settings.module.css";

// The in-app settings screen. Reads the reactive settings store and writes back
// through saveSettings (which persists to settings.json and applies live). A
// portaled overlay like the other modals: Escape / backdrop click closes, the
// first control takes focus on open.
export default function Settings(props: { onClose: () => void }) {
  let firstControl: HTMLSelectElement | undefined;
  onMount(() => requestAnimationFrame(() => firstControl?.focus()));

  const setAppearance = (a: Partial<Appearance>) =>
    saveSettings({ ...settings, appearance: { ...settings.appearance, ...a } });
  const setTypography = (t: Partial<Typography>) =>
    saveSettings({ ...settings, typography: { ...settings.typography, ...t } });
  const setLayout = (l: Partial<Layout>) =>
    saveSettings({ ...settings, layout: { ...settings.layout, ...l } });

  // Reject empty/NaN/out-of-range commits (a blank or 0 font size would blank
  // the UI); fall back to the current value so an invalid entry is a no-op.
  const clamp = (v: string, min: number, max: number, fallback: number) => {
    const n = Number(v);
    if (v.trim() === "" || !Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };

  async function importTheme() {
    const path = await invoke<string | null>("pick_theme_file").catch(() => null);
    if (path) setAppearance({ theme: "import", importPath: path });
  }

  const currentTheme = () =>
    settings.appearance.theme === "import" ? "import" : settings.appearance.theme;

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
            <section class={styles.section}>
              <div class={styles.sectionTitle}>Appearance</div>
              <div class={styles.row}>
                <label class={styles.label}>Theme</label>
                <div class={styles.control}>
                  <select
                    ref={firstControl}
                    class={styles.select}
                    value={currentTheme()}
                    onChange={(e) => setAppearance({ theme: e.currentTarget.value, importPath: null })}
                  >
                    <For each={listSelectableThemes()}>
                      {(t) => <option value={t.id}>{t.label}</option>}
                    </For>
                    <Show when={settings.appearance.theme === "import"}>
                      <option value="import">Imported</option>
                    </Show>
                  </select>
                  <Button variant="ghost" size="sm" onClick={importTheme}>
                    Import theme…
                  </Button>
                </div>
              </div>
              <Show when={settings.appearance.theme === "import" && settings.appearance.importPath}>
                <div class={styles.hint}>Imported: {settings.appearance.importPath}</div>
              </Show>
            </section>

            <section class={styles.section}>
              <div class={styles.sectionTitle}>Typography</div>
              <div class={styles.row}>
                <label class={styles.label}>UI font family</label>
                <input
                  class={`${styles.input} ${styles.text}`}
                  value={settings.typography.uiFontFamily}
                  onChange={(e) => setTypography({ uiFontFamily: e.currentTarget.value })}
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
                  value={settings.typography.editorFontFamily}
                  onChange={(e) => setTypography({ editorFontFamily: e.currentTarget.value })}
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
              <div class={styles.sectionTitle}>Layout</div>
              <div class={styles.row}>
                <label class={styles.label}>Density</label>
                <select
                  class={styles.select}
                  value={settings.layout.density}
                  onChange={(e) =>
                    setLayout({ density: e.currentTarget.value as Layout["density"] })
                  }
                >
                  <option value="comfortable">Comfortable</option>
                  <option value="compact">Compact</option>
                </select>
              </div>
              <div class={styles.row}>
                <label class={styles.label}>Corner radius</label>
                <input
                  type="number"
                  min="0"
                  max="16"
                  class={`${styles.input} ${styles.num}`}
                  value={settings.layout.radius}
                  onChange={(e) => setLayout({ radius: clamp(e.currentTarget.value, 0, 16, settings.layout.radius) })}
                />
              </div>
            </section>
          </div>
        </div>
      </div>
    </Portal>
  );
}

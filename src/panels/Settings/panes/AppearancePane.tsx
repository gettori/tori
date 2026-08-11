import { createMemo, For, Show } from "solid-js";
import {
  EDITOR_FONT_FALLBACK,
  Group,
  Row,
  TERMINAL_FONT_FALLBACK,
  UI_FONT_FALLBACK,
  clamp,
  idsIn,
  setAppearance,
  setTypography,
  withFallback,
  type PaneProps,
} from "../paneKit";
import { settings, setZoom, zoom, ZOOM_MAX, ZOOM_MIN } from "../settingsStore";
import { listSelectableThemes, DEFAULT_THEME_ID } from "../../../theme";
import { primaryFamily } from "../../../utils/fontLoad";
import styles from "../Settings.module.css";

/** The theme picker and the type scale: everything about what the app looks
 *  like, which is the one question a user arrives at this tab with. */
export default function AppearancePane(props: PaneProps) {
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
    themes().some((t) => t.id === settings.appearance.theme)
      ? settings.appearance.theme
      : DEFAULT_THEME_ID;

  return (
    <>
      {/* "Display" rather than "Theme": the group holds the theme and the zoom,
          and naming it after one of its two rows read as a mislabel. */}
      <Group {...props} title="Display" ids={idsIn("appearance")}>
        <Row {...props} id="theme" label="Theme">
          <div class={styles.control}>
            <select
              class={styles.select}
              value={currentTheme()}
              onChange={(e) => setAppearance({ theme: e.currentTarget.value })}
            >
              {/* Grouped by source so a user theme is visibly not one of Sway's,
                  and a file dropped in the folder is visibly the thing that
                  appeared. The user group is omitted entirely when the folder is
                  empty, rather than shown empty. */}
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
        </Row>
        <Row {...props} id="zoom" label="Zoom">
          {/* Percent in the field, a multiplier in the store. Both the row and
              the hotkeys go through `setZoom`, which clamps and persists, so the
              number here is always the one the app is actually at. */}
          <input
            type="number"
            min={ZOOM_MIN * 100}
            max={ZOOM_MAX * 100}
            step="10"
            class={`${styles.input} ${styles.num}`}
            value={Math.round(zoom() * 100)}
            onChange={(e) =>
              setZoom(
                clamp(e.currentTarget.value, ZOOM_MIN * 100, ZOOM_MAX * 100, Math.round(zoom() * 100)) / 100,
              )
            }
          />
        </Row>
      </Group>

      <Group {...props} title="Typography" ids={idsIn("typography")}>
        <Row {...props} id="ui-font-family" label="UI font family">
          <input
            class={`${styles.input} ${styles.text}`}
            value={primaryFamily(settings.typography.uiFontFamily)}
            onChange={(e) =>
              setTypography({ uiFontFamily: withFallback(e.currentTarget.value, UI_FONT_FALLBACK) })
            }
          />
        </Row>
        <Row {...props} id="ui-font-size" label="UI font size">
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
        </Row>
        <Row {...props} id="editor-font-family" label="Editor font family">
          <input
            class={`${styles.input} ${styles.text}`}
            value={primaryFamily(settings.typography.editorFontFamily)}
            onChange={(e) =>
              setTypography({
                editorFontFamily: withFallback(e.currentTarget.value, EDITOR_FONT_FALLBACK),
              })
            }
          />
        </Row>
        <Row {...props} id="editor-font-size" label="Editor font size">
          <input
            type="number"
            min="9"
            max="24"
            class={`${styles.input} ${styles.num}`}
            value={settings.typography.editorFontSize}
            onChange={(e) =>
              setTypography({
                editorFontSize: clamp(e.currentTarget.value, 9, 24, settings.typography.editorFontSize),
              })
            }
          />
        </Row>
        <Row
          {...props}
          id="terminal-font-family"
          label="Terminal font family"
          /* Worth naming: it is the one family here that needs no install, and
             its exact spelling is not guessable. */
          hint="JetBrainsMono Nerd Font Mono ships with Sway, so its icon glyphs render without a font install. Any family on this machine works too."
        >
          <input
            class={`${styles.input} ${styles.text}`}
            value={primaryFamily(settings.typography.terminalFontFamily)}
            onChange={(e) =>
              setTypography({
                terminalFontFamily: withFallback(e.currentTarget.value, TERMINAL_FONT_FALLBACK),
              })
            }
          />
        </Row>
        <Row {...props} id="terminal-font-size" label="Terminal font size">
          <input
            type="number"
            min="9"
            max="24"
            class={`${styles.input} ${styles.num}`}
            value={settings.typography.terminalFontSize}
            onChange={(e) =>
              setTypography({
                terminalFontSize: clamp(e.currentTarget.value, 9, 24, settings.typography.terminalFontSize),
              })
            }
          />
        </Row>
        <Row {...props} id="line-height" label="Line height">
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
        </Row>
      </Group>
    </>
  );
}

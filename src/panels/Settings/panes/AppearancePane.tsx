import { createMemo } from "solid-js";
import {
  EDITOR_FONT_FALLBACK,
  Group,
  Row,
  Stepper,
  TERMINAL_FONT_FALLBACK,
  UI_FONT_FALLBACK,
  idsIn,
  rowLabelId,
  setAppearance,
  setTypography,
  withFallback,
  type PaneProps,
} from "../paneKit";
import { settings, setZoom, zoom, ZOOM_MAX, ZOOM_MIN } from "../settingsStore";
import { listSelectableThemes, DEFAULT_THEME_ID } from "../../../theme";
import { primaryFamily } from "../../../utils/fontLoad";
import Select, { type SelectGroup, type SelectOption } from "../../../components/Select/Select";
import styles from "../Settings.module.css";

/** A theme as a row: the id is what settings.json stores, the label is what the
 *  user reads. */
const asOption = (t: { id: string; label: string }): SelectOption => ({
  value: t.id,
  label: t.label,
});

/** The theme picker and the type scale: everything about what the app looks
 *  like, which is the one question a user arrives at this tab with. */
export default function AppearancePane(props: PaneProps) {
  // One memo, split into the two groups the picker renders. The list folds the
  // bundled set together with whatever is in the themes folder, so rebuilding it
  // per group would do that work twice for one render.
  const themes = createMemo(() => listSelectableThemes());
  const bundledThemes = createMemo(() => themes().filter((t) => t.source === "bundled"));
  const userThemes = createMemo(() => themes().filter((t) => t.source !== "bundled"));

  // Grouped by source so a user theme is visibly not one of Sway's, and a file
  // dropped in the folder is visibly the thing that appeared. The user group is
  // omitted entirely when the folder is empty, rather than shown empty.
  const themeGroups = createMemo<SelectGroup[]>(() => [
    { label: "Bundled", options: bundledThemes().map(asOption) },
    ...(userThemes().length > 0
      ? [{ label: "From ~/.config/sway/themes", options: userThemes().map(asOption) }]
      : []),
  ]);

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
            <Select
              options={themeGroups()}
              value={currentTheme()}
              onChange={(value) => setAppearance({ theme: value })}
              aria-labelledby={rowLabelId("theme")}
            />
          </div>
        </Row>
        <Row {...props} id="zoom" label="Zoom">
          {/* Percent in the field, a multiplier in the store. Both the row and
              the hotkeys go through `setZoom`, which clamps and persists, so the
              number here is always the one the app is actually at. */}
          <Stepper
            aria-label="Zoom"
            min={ZOOM_MIN * 100}
            max={ZOOM_MAX * 100}
            step={10}
            value={Math.round(zoom() * 100)}
            onChange={(v) => setZoom(v / 100)}
          />
        </Row>
      </Group>

      <Group {...props} title="Typography" ids={idsIn("typography")}>
        <Row {...props} id="ui-font-family" label="UI font family">
          <input
            class={`${styles.input} ${styles.text}`}
            aria-label="UI font family"
            value={primaryFamily(settings.typography.uiFontFamily)}
            onChange={(e) =>
              setTypography({ uiFontFamily: withFallback(e.currentTarget.value, UI_FONT_FALLBACK) })
            }
          />
        </Row>
        <Row {...props} id="ui-font-size" label="UI font size">
          <Stepper
            aria-label="UI font size"
            min={9}
            max={24}
            value={settings.typography.uiFontSize}
            onChange={(v) => setTypography({ uiFontSize: v })}
          />
        </Row>
        <Row {...props} id="editor-font-family" label="Editor font family">
          <input
            class={`${styles.input} ${styles.text}`}
            aria-label="Editor font family"
            value={primaryFamily(settings.typography.editorFontFamily)}
            onChange={(e) =>
              setTypography({
                editorFontFamily: withFallback(e.currentTarget.value, EDITOR_FONT_FALLBACK),
              })
            }
          />
        </Row>
        <Row {...props} id="editor-font-size" label="Editor font size">
          <Stepper
            aria-label="Editor font size"
            min={9}
            max={24}
            value={settings.typography.editorFontSize}
            onChange={(v) => setTypography({ editorFontSize: v })}
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
            aria-label="Terminal font family"
            value={primaryFamily(settings.typography.terminalFontFamily)}
            onChange={(e) =>
              setTypography({
                terminalFontFamily: withFallback(e.currentTarget.value, TERMINAL_FONT_FALLBACK),
              })
            }
          />
        </Row>
        <Row {...props} id="terminal-font-size" label="Terminal font size">
          <Stepper
            aria-label="Terminal font size"
            min={9}
            max={24}
            value={settings.typography.terminalFontSize}
            onChange={(v) => setTypography({ terminalFontSize: v })}
          />
        </Row>
        <Row {...props} id="line-height" label="Line height">
          <Stepper
            aria-label="Line height"
            min={1}
            max={2.5}
            step={0.1}
            value={settings.typography.lineHeight}
            onChange={(v) => setTypography({ lineHeight: v })}
          />
        </Row>
      </Group>
    </>
  );
}

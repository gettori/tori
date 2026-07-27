import { createSignal, createEffect, createMemo, For, Show } from "solid-js";
import { Settings, Search, ChevronRight, GitBranch, FileCode, Bot, PanelRight, FileText } from "lucide-solid";
import Icon from "../components/Icon/Icon";
import Button from "../components/Button/Button";
import type { ButtonVariant, ButtonSize } from "../components/Button/Button";
import IconButton from "../components/IconButton/IconButton";
import SegmentedControl from "../components/SegmentedControl/SegmentedControl";
import Tab from "../components/Tab/Tab";
import type { ControlSize } from "../components/controls";
import FileIcon from "../seti/FileIcon";
import { checkPalette } from "../theme/contrast";
import { applyResolved } from "../theme/resolver";
import { buildRoles, ROLE_BY_ID, ROLES } from "../theme/roles";
import { DEFAULT_THEME_ID, listSelectableThemes } from "../theme";
import styles from "./Styleguide.module.css";
import patterns from "../styles/patterns.module.css";

/** Dev-only theme workbench. NOT a router route (sway has none): App renders it
 *  when `import.meta.env.DEV && location.hash === "#styleguide"`. It drives the
 *  real theme registry and the real `--ui-scale` inline prop, so a palette can
 *  be authored here and checked in every surface it touches, at any UI scale.
 *
 *  The role gallery is DERIVED from `ROLES` rather than curated. A hand-listed
 *  gallery goes stale the moment a role is added, and it goes stale silently:
 *  the missing role simply is not shown, which looks exactly like a role that
 *  has nothing to show. */

const BRAND_NOTES: Record<string, string> = {
  "--brand-default": "primary gold: icons, active text",
  "--brand-strong": "hover / emphasis",
  "--brand-subtle": "pill fill (translucent)",
  "--brand-bar": "left active-item accent bar",
  "--brand-ring": "focus ring (translucent)",
  "--brand-on": "text/icon on a filled --brand-default surface",
};

/** The 16-slot ANSI ramp, in the order a terminal indexes it. */
const ANSI_SLOTS = ROLES.filter(
  (r) => r.group === "ansi" && r.id !== "ansi.cursor" && r.id !== "ansi.selection",
);

/** A code sample that exercises one syntax role per span, so a ramp with two
 *  categories accidentally equal is visible rather than merely measurable. */
const SYNTAX_SAMPLE: [string, string][] = [
  ["syntax.comment", "// resolve a theme"], ["", "\n"],
  ["syntax.keyword", "export"], ["", " "],
  ["syntax.control", "async"], ["", " "],
  ["syntax.keyword", "function"], ["", " "],
  ["syntax.function", "resolve"], ["syntax.punctuation", "("],
  ["syntax.parameter", "id"], ["syntax.punctuation", ":"], ["", " "],
  ["syntax.type", "ThemeId"], ["syntax.punctuation", ")"], ["", " "],
  ["syntax.punctuation", "{"], ["", "\n  "],
  ["syntax.control", "const"], ["", " "],
  ["syntax.variable", "raw"], ["", " "],
  ["syntax.operator", "="], ["", " "],
  ["syntax.control", "await"], ["", " "],
  ["syntax.namespace", "fs"], ["syntax.punctuation", "."],
  ["syntax.method", "readFile"], ["syntax.punctuation", "("],
  ["syntax.string", '"palette.json"'], ["syntax.punctuation", ");"], ["", "\n  "],
  ["syntax.control", "return"], ["", " "],
  ["syntax.class", "Palette"], ["syntax.punctuation", "."],
  ["syntax.method", "parse"], ["syntax.punctuation", "("],
  ["syntax.variable", "raw"], ["syntax.punctuation", ","], ["", " "],
  ["syntax.number", "1"], ["syntax.punctuation", ","], ["", " "],
  ["syntax.constant", "STRICT"], ["syntax.punctuation", ");"], ["", "\n"],
  ["syntax.punctuation", "}"], ["", "\n"],
  ["syntax.regexp", "/\\bsway-[a-z]+\\b/"], ["", "  "],
  ["syntax.string", '"tab\\t"'], ["syntax.escape", "\\n"], ["", "\n"],
  ["syntax.punctuation", "<"], ["syntax.tag", "button"], ["", " "],
  ["syntax.attribute", "disabled"], ["syntax.punctuation", "/>"],
];

/** Chosen so all eleven `scale.*` hues are on screen at once: a hue with no file
 *  in this list is a hue nobody would notice going wrong. */
const ICON_SAMPLE = [
  "index.ts", "readme.md", "styles.css", "main.rs", "app.py", "Cargo.toml",
  "package.json", "logo.svg", "Dockerfile", "notes.txt", "script.sh",
  "photo.png", "index.html", "query.sql", "vite.config.ts",
  "Main.java", "pom.xml", ".gitconfig", ".dockerignore",
];

const SPACE = ["1", "2", "3", "4", "5", "6", "7", "8"] as const;
const RADII = ["sm", "md", "lg", "pill"] as const;
const SHADOWS = ["sm", "md", "lg"] as const;
const TYPE = ["2xs", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"] as const;
const VARIANTS: ButtonVariant[] = ["default", "primary", "success", "warn", "danger", "ghost"];
const SIZES: ButtonSize[] = ["md", "sm", "xs"];

export default function Styleguide() {
  const themes = listSelectableThemes();
  const [themeId, setThemeId] = createSignal(DEFAULT_THEME_ID);
  const [scale, setScale] = createSignal(1);
  // Interactive state for the control-family gallery below.
  const [toggled, setToggled] = createSignal(true);
  const [seg, setSeg] = createSignal<"files" | "changes" | "search">("files");
  const [activeTab, setActiveTab] = createSignal(0);

  const active = createMemo(() => themes.find((t) => t.id === themeId()) ?? themes[0]);
  /** The gate's verdict on the theme currently painted, recomputed on switch. */
  const gate = createMemo(() => checkPalette(active().palette));
  const failedVars = createMemo(() => new Set(gate().failures.map((f) => f.cssVar)));

  // Paints through the real resolver, so what is on screen is exactly what a
  // user selecting this theme would get, inline props and all - but deliberately
  // NOT through setTheme, which also persists the selection. Clicking through
  // five themes in a dev surface must not silently rewrite which theme the app
  // boots into.
  createEffect(() => {
    const theme = active();
    applyResolved(buildRoles(theme.palette), theme.appearance);
  });
  createEffect(() => {
    document.documentElement.style.setProperty("--ui-scale", String(scale()));
  });

  return (
    <div class={styles.page}>
      <header class={styles.bar}>
        <strong class={styles.title}>
          <Icon icon={Settings} /> sway theme workbench
        </strong>
        <div class={styles.controls}>
          <select
            class={styles.picker}
            value={themeId()}
            onChange={(e) => setThemeId(e.currentTarget.value)}
          >
            <For each={themes}>{(t) => <option value={t.id}>{t.label}</option>}</For>
          </select>
          <label class={styles.slider}>
            scale {scale().toFixed(2)}
            <input type="range" min="0.85" max="1.4" step="0.05" value={scale()} onInput={(e) => setScale(+e.currentTarget.value)} />
          </label>
        </div>
      </header>

      <main class={styles.body}>
        <section>
          <h2>Contrast gate</h2>
          <Show
            when={gate().failures.length > 0 || gate().problems.length > 0}
            fallback={
              <p class={styles.gatePass}>
                {active().label} clears every declared floor across all {ROLES.length} roles.
              </p>
            }
          >
            <ul class={styles.gateList}>
              <For each={gate().problems}>{(p) => <li class={styles.gateFail}>{p}</li>}</For>
              <For each={gate().failures}>
                {(f) => (
                  <li class={styles.gateFail}>
                    <code>{f.cssVar}</code> on <code>{f.surface}</code> is{" "}
                    {f.ratio.toFixed(2)}, needs {f.required.toFixed(1)} ({f.tier})
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>

        <section>
          <h2>Terminal (16-slot ANSI ramp)</h2>
          <div class={styles.ansiRow}>
            <For each={ANSI_SLOTS}>
              {(role) => (
                <div
                  class={styles.ansiCell}
                  classList={{ [styles.failing]: failedVars().has(role.cssVar) }}
                >
                  <div class={styles.ansiChip} style={{ background: `var(${role.cssVar})` }} />
                  <code>{role.id.slice("ansi.".length)}</code>
                </div>
              )}
            </For>
          </div>
          <pre class={styles.terminalSample}>
            <span style={{ color: "var(--ansi-green)" }}>PASS</span>
            {"  "}
            <span style={{ color: "var(--ansi-red)" }}>FAIL</span>
            {"  "}
            <span style={{ color: "var(--ansi-yellow)" }}>SKIP</span>
            {"  "}
            <span style={{ color: "var(--ansi-bright-black)" }}>12 skipped</span>
          </pre>
        </section>

        <section>
          <h2>Editor (syntax)</h2>
          <pre class={styles.syntaxSample}>
            <For each={SYNTAX_SAMPLE}>
              {([id, text]) => (
                <Show when={id ? ROLE_BY_ID.get(id) : undefined} fallback={text} keyed>
                  {(role) => (
                    <span
                      style={{ color: `var(${role.cssVar})` }}
                      classList={{ [styles.failing]: failedVars().has(role.cssVar) }}
                    >
                      {text}
                    </span>
                  )}
                </Show>
              )}
            </For>
          </pre>
        </section>

        <section>
          <h2>File icons (seti hues via scale.*)</h2>
          <div class={styles.iconGrid}>
            <For each={ICON_SAMPLE}>
              {(name) => (
                <span class={styles.iconCell}>
                  <FileIcon name={name} />
                  <code>{name}</code>
                </span>
              )}
            </For>
          </div>
        </section>

        <section>
          <h2>Brand (champagne gold)</h2>
          <div class={styles.swatches}>
            <For each={ROLES.filter((r) => r.group === "brand")}>
              {(role) => (
                <div class={styles.swatch}>
                  <div class={styles.chip} style={{ background: `var(${role.cssVar})` }} />
                  <code>{role.cssVar}</code>
                  <span class={styles.note}>{BRAND_NOTES[role.cssVar] ?? role.id}</span>
                  <p class={styles.brandText} style={{ color: `var(${role.cssVar})` }}>
                    The quick brown fox — legible on brand
                  </p>
                </div>
              )}
            </For>
          </div>
          <div class={styles.pillRow}>
            <span class={styles.pill}>active pill (--brand-subtle)</span>
            <span class={styles.barItem}>left accent bar (--brand-bar)</span>
            <button class={styles.ringBtn}>focus ring (--brand-ring)</button>
          </div>
        </section>

        <section>
          <h2>Roles ({ROLES.length} across {new Set(ROLES.map((r) => r.group)).size} families)</h2>
          <For each={[...new Set(ROLES.map((r) => r.group))]}>
            {(group) => (
              <>
                <h3 class={styles.groupHead}>{group}</h3>
                <div class={styles.roleGrid}>
                  <For each={ROLES.filter((r) => r.group === group)}>
                    {(role) => (
                      <div
                        class={styles.roleCell}
                        classList={{ [styles.failing]: failedVars().has(role.cssVar) }}
                      >
                        <div class={styles.roleChip} style={{ background: `var(${role.cssVar})` }} />
                        <code>{role.cssVar}</code>
                      </div>
                    )}
                  </For>
                </div>
              </>
            )}
          </For>
        </section>

        <section>
          <h2>Elevation</h2>
          <div class={styles.shadowRow}>
            <For each={SHADOWS}>
              {(s) => (
                <div class={styles.shadowBox} style={{ "box-shadow": `var(--shadow-${s})` }}>
                  --shadow-{s}
                </div>
              )}
            </For>
          </div>
        </section>

        <section>
          <h2>Type & weight</h2>
          <p style={{ "font-weight": 400 }}>400 — regular. The quick brown fox jumps over the lazy dog.</p>
          <p style={{ "font-weight": 500 }}>500 — medium. The quick brown fox jumps over the lazy dog.</p>
          <p style={{ "font-weight": 600 }}>600 — semibold. The quick brown fox jumps over the lazy dog.</p>
          <p style={{ "font-weight": 700 }}>700 — bold. The quick brown fox jumps over the lazy dog.</p>
          <div class={styles.typeScale}>
            <For each={TYPE}>
              {(t) => <span style={{ "font-size": `var(--sway-text-${t})` }}>text-{t}</span>}
            </For>
          </div>
        </section>

        <section>
          <h2>Spacing & radii</h2>
          <div class={styles.spaceRow}>
            <For each={SPACE}>
              {(n) => (
                <div class={styles.spaceItem}>
                  <div class={styles.spaceBar} style={{ width: `var(--sway-space-${n})` }} />
                  <code>space-{n}</code>
                </div>
              )}
            </For>
          </div>
          <div class={styles.radiiRow}>
            <For each={RADII}>
              {(r) => (
                <div class={styles.radiusBox} style={{ "border-radius": `var(--sway-radius-${r})` }}>
                  radius-{r}
                </div>
              )}
            </For>
          </div>
        </section>

        <section>
          <h2>Buttons</h2>
          <For each={SIZES}>
            {(size) => (
              <div class={styles.btnRow}>
                <For each={VARIANTS}>
                  {(variant) => (
                    <Button variant={variant} size={size}>
                      {variant}
                    </Button>
                  )}
                </For>
              </div>
            )}
          </For>
        </section>

        <section>
          <h2>Controls (icon button, segmented, tab)</h2>
          <p class={styles.note}>
            Each control of a size is exactly one fixed height (28 / 24 / 20 &times; scale), so a
            button, an icon button, a segmented strip, and a tab all line up.
          </p>
          <For each={SIZES as ControlSize[]}>
            {(size) => (
              <div class={styles.btnRow}>
                <Button size={size} icon={<Icon icon={PanelRight} />}>
                  text + icon
                </Button>
                <IconButton size={size} icon={<Icon icon={Bot} />} aria-label="Bot" title="Bot" />
                <IconButton
                  size={size}
                  active={toggled()}
                  icon={<Icon icon={Bot} />}
                  aria-label="Follow"
                  title="Toggle follow"
                  onClick={() => setToggled((v) => !v)}
                />
                <SegmentedControl
                  size={size}
                  aria-label="Right panel"
                  value={seg()}
                  onChange={setSeg}
                  options={[
                    { value: "files", label: "Files" },
                    { value: "changes", label: "Changes" },
                    { value: "search", label: "Search" },
                  ]}
                />
              </div>
            )}
          </For>
          <div class={styles.btnRow}>
            <For each={["README.md", "tokens.css", "settings.rs"]}>
              {(name, i) => (
                <Tab
                  active={activeTab() === i()}
                  icon={<Icon icon={FileText} />}
                  onClick={() => setActiveTab(i())}
                  onClose={() => {}}
                  closeLabel={`Close ${name}`}
                >
                  {name}
                </Tab>
              )}
            </For>
          </div>
        </section>

        <section>
          <h2>Chrome patterns</h2>
          <div class={styles.patternGrid}>
            <div class={styles.patternCell}>
              <span class={styles.note}>input (.input)</span>
              <input class={patterns.input} placeholder="Focus me for the gold ring" />
            </div>
            <div class={styles.patternCell}>
              <span class={styles.note}>menu surface (.menuSurface)</span>
              <div class={patterns.menuSurface}>
                <div class={styles.menuRow}>Menu item</div>
                <div class={styles.menuRow}>Another item</div>
              </div>
            </div>
            <div class={styles.patternCell}>
              <span class={styles.note}>pill (.pill)</span>
              <span class={patterns.pill}>
                <Icon icon={GitBranch} size={13} /> active pill
              </span>
            </div>
            <div class={styles.patternCell}>
              <span class={styles.note}>card (.card)</span>
              <div class={patterns.card}>A spacious card with soft elevation.</div>
            </div>
          </div>
        </section>

        <section>
          <h2>Icons (Lucide @ 1.75 stroke)</h2>
          <div class={styles.iconRow}>
            <Icon icon={Settings} />
            <Icon icon={Search} />
            <Icon icon={ChevronRight} />
            <Icon icon={GitBranch} />
            <Icon icon={FileCode} />
            <Icon icon={Settings} size={28} strokeWidth={1.5} />
          </div>
        </section>
      </main>
    </div>
  );
}

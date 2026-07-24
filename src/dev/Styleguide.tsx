import { createSignal, createEffect, For } from "solid-js";
import { Settings, Search, ChevronRight, GitBranch, FileCode } from "lucide-solid";
import Icon from "../components/Icon/Icon";
import Button from "../components/Button/Button";
import type { ButtonVariant, ButtonSize } from "../components/Button/Button";
import styles from "./Styleguide.module.css";
import patterns from "../styles/patterns.module.css";

/** Dev-only visual QA surface for the design system. NOT a router route (sway
 *  has none): App renders it when `import.meta.env.DEV && location.hash ===
 *  "#styleguide"`. It drives the real `--ui-*` inline props and `data-theme` so
 *  every phase's tokens can be checked in both themes and at non-default
 *  density/scale/radius. */

const BRAND = [
  ["--brand-default", "primary gold: icons, active text"],
  ["--brand-strong", "hover / emphasis"],
  ["--brand-subtle", "pill fill (translucent)"],
  ["--brand-bar", "left active-item accent bar"],
  ["--brand-ring", "focus ring (translucent)"],
  ["--brand-on", "text/icon on a filled --brand-default surface"],
] as const;

const SEMANTIC = [
  "--canvas-default",
  "--canvas-card",
  "--canvas-head",
  "--border-default",
  "--fg-default",
  "--fg-muted",
  "--accent-fg",
  "--accent-subtle",
  "--neutral-hover",
  "--canvas-input",
  "--danger-fg",
  "--attention-fg",
  "--attention-emphasis",
  "--success-fg",
] as const;

const SPACE = ["1", "2", "3", "4", "5", "6", "7", "8"] as const;
const RADII = ["sm", "md", "lg", "pill"] as const;
const SHADOWS = ["sm", "md", "lg"] as const;
const TYPE = ["xs", "sm", "md", "lg", "xl"] as const;
const VARIANTS: ButtonVariant[] = ["default", "primary", "success", "warn", "danger", "ghost"];
const SIZES: ButtonSize[] = ["md", "sm", "xs"];

export default function Styleguide() {
  const [theme, setTheme] = createSignal<"dark" | "light">(
    (document.documentElement.dataset.theme as "dark" | "light") || "dark",
  );
  const [density, setDensity] = createSignal(1);
  const [scale, setScale] = createSignal(1);
  const [radius, setRadius] = createSignal(1);

  createEffect(() => {
    document.documentElement.dataset.theme = theme();
  });
  createEffect(() => {
    const st = document.documentElement.style;
    st.setProperty("--ui-density", String(density()));
    st.setProperty("--ui-scale", String(scale()));
    st.setProperty("--ui-radius-scale", String(radius()));
  });

  return (
    <div class={styles.page}>
      <header class={styles.bar}>
        <strong class={styles.title}>
          <Icon icon={Settings} /> sway styleguide
        </strong>
        <div class={styles.controls}>
          <div class={styles.seg}>
            <button classList={{ [styles.on]: theme() === "dark" }} onClick={() => setTheme("dark")}>
              dark
            </button>
            <button classList={{ [styles.on]: theme() === "light" }} onClick={() => setTheme("light")}>
              light
            </button>
          </div>
          <div class={styles.seg}>
            <button classList={{ [styles.on]: density() === 1 }} onClick={() => setDensity(1)}>
              comfortable
            </button>
            <button classList={{ [styles.on]: density() === 0.85 }} onClick={() => setDensity(0.85)}>
              compact
            </button>
          </div>
          <label class={styles.slider}>
            scale {scale().toFixed(2)}
            <input type="range" min="0.85" max="1.4" step="0.05" value={scale()} onInput={(e) => setScale(+e.currentTarget.value)} />
          </label>
          <label class={styles.slider}>
            radius {radius().toFixed(2)}
            <input type="range" min="0.4" max="2" step="0.1" value={radius()} onInput={(e) => setRadius(+e.currentTarget.value)} />
          </label>
        </div>
      </header>

      <main class={styles.body}>
        <section>
          <h2>Brand (champagne gold)</h2>
          <div class={styles.swatches}>
            <For each={BRAND}>
              {([name, note]) => (
                <div class={styles.swatch}>
                  <div class={styles.chip} style={{ background: `var(${name})` }} />
                  <code>{name}</code>
                  <span class={styles.note}>{note}</span>
                  <p class={styles.brandText} style={{ color: `var(${name})` }}>
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
          <h2>Semantic colors</h2>
          <div class={styles.swatches}>
            <For each={SEMANTIC}>
              {(name) => (
                <div class={styles.swatch}>
                  <div class={styles.chip} style={{ background: `var(${name})` }} />
                  <code>{name}</code>
                </div>
              )}
            </For>
          </div>
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

import { For, Show, Switch, Match, createResource } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import styles from "./Settings.module.css";

// One card per registered language server, answering the same question the
// Agents cards answer for agent CLIs: "which languages does this thing
// actually have intelligence for on my machine?" The backend (`lsp_health`)
// resolves each binary against the login-shell PATH, so a server installed via
// rustup/mise shows as found rather than missing.
//
// Same tone rule as the agent cards: a missing server is not an error. Nobody
// has every language installed, so an uninstalled one gets an install hint and
// an unparseable version gets neutral text, never red.

type BinaryStatus = "notFound" | "versionUnknown" | "versionMatch" | "versionDrift";

export type LspHealth = {
  id: string;
  label: string;
  program: string;
  status: BinaryStatus;
  path: string | null;
  version: string | null;
  verifiedAgainst: string | null;
  extensions: string[];
  // Set when something other than a missing `program` is wrong: today, a
  // bundled server whose entry script was never installed. `node` resolves
  // fine in that case, so without this the card would read healthy while every
  // start failed.
  detail: string | null;
  overridePath: string | null;
};

// Identical mapping to the agent cards, and for the same reason: the dot
// answers "is this usable?" and nothing else, so `versionUnknown` is green.
// Neither bundled config declares a `verified_against`, so dimming them over
// Sway's own missing bookkeeping would mark two healthy servers as worse off.
const TONE: Record<BinaryStatus, string> = {
  versionMatch: styles.dotOk,
  versionUnknown: styles.dotOk,
  versionDrift: styles.dotWarn,
  notFound: styles.dotOff,
};

function LspCard(props: { server: LspHealth }) {
  const s = () => props.server;
  return (
    <div class={styles.card}>
      <div class={styles.cardHead}>
        <span class={`${styles.dot} ${TONE[s().status]}`} />
        <span class={styles.cardTitle}>{s().label}</span>
        <code class={styles.cardProgram}>{s().program}</code>
      </div>

      <div class={styles.cardStatus}>
        <Switch>
          {/* Most specific first: a bundled server can be "not found" while its
              interpreter is present, and naming the interpreter there would
              send the user off installing something they already have. */}
          <Match when={s().detail}>{(detail) => <>{detail()}</>}</Match>
          <Match when={s().status === "notFound"}>
            Not installed. Install <code>{s().program}</code> and reopen Sway to pick it up.
          </Match>
          <Match when={s().status === "versionMatch"}>Installed, version {s().version}.</Match>
          <Match when={s().status === "versionUnknown" && s().version}>
            Installed, version {s().version}.
          </Match>
          <Match when={s().status === "versionUnknown"}>
            Installed. It does not report a version, so Sway cannot check it.
          </Match>
          <Match when={s().status === "versionDrift"}>
            Installed, version {s().version}. Sway's config was built against {s().verifiedAgainst},
            so some behaviour may differ.
          </Match>
        </Switch>
      </div>

      <div class={styles.chips}>
        <For each={s().extensions}>
          {(ext) => <span class={styles.chip}>.{ext}</span>}
        </For>
      </div>

      <Show when={s().overridePath}>
        {(path) => <div class={styles.hint}>Overridden by {path()}</div>}
      </Show>
    </div>
  );
}

export default function LspSection() {
  const [health] = createResource(() => invoke<LspHealth[]>("lsp_health"));

  return (
    <section class={styles.section}>
      <div class={styles.sectionTitle}>
        <span>Language servers</span>
        <span class={styles.sectionRule} />
      </div>
      <Switch>
        <Match when={health.loading}>
          <div class={styles.note}>Checking which language servers are installed…</div>
        </Match>
        <Match when={health.error}>
          <div class={styles.note}>Could not check language servers: {String(health.error)}</div>
        </Match>
        <Match when={health()}>
          <div class={styles.cardStack}>
            <For each={health()}>{(server) => <LspCard server={server} />}</For>
          </div>
          <div class={styles.note}>
            A language with no server still opens and edits normally, it just has no completion or
            diagnostics. Add one with a TOML file in <code>~/.config/sway/lsp/</code>; see
            LSP-SERVERS.md.
          </div>
        </Match>
      </Switch>
    </section>
  );
}

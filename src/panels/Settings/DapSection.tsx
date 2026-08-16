import { For, Switch, Match, createResource } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import styles from "./Settings.module.css";

// One card per debug adapter, answering for the debugger what the LSP cards
// answer for intelligence: "can this thing actually run here?"
//
// Two things have to be true, and the card says which one is not. `node` has to
// resolve on the login-shell PATH, and the adapter bundle has to have been
// installed, which is a build step rather than something a user does. Reporting
// the card healthy on `node` alone would be exactly the failure
// lesson_the_handshake_succeeded_and_the_feature_is_silent describes: every
// start fails while the surface that should have said so reads fine.

type BinaryStatus = "notFound" | "versionUnknown" | "versionMatch" | "versionDrift";

export type DapHealth = {
  id: string;
  label: string;
  program: string;
  status: BinaryStatus;
  path: string | null;
  version: string | null;
  adapterVersion: string;
  extensions: string[];
  detail: string | null;
};

// Same mapping as the LSP and agent cards: the dot answers "is this usable?"
// and nothing else, so `versionUnknown` is green.
const TONE: Record<BinaryStatus, string> = {
  versionMatch: styles.dotOk,
  versionUnknown: styles.dotOk,
  versionDrift: styles.dotWarn,
  notFound: styles.dotOff,
};

function DapCard(props: { adapter: DapHealth }) {
  const a = () => props.adapter;
  return (
    <div class={styles.card}>
      <div class={styles.cardHead}>
        <span class={`${styles.dot} ${TONE[a().status]}`} />
        <span class={styles.cardTitle}>{a().label}</span>
        <code class={styles.cardProgram}>{a().program}</code>
      </div>

      <div class={styles.cardStatus}>
        <Switch>
          {/* Most specific first: the bundle can be missing while `node` is
              present, and naming `node` there sends someone off installing
              something they already have. */}
          <Match when={a().detail}>{(detail) => <>{detail()}</>}</Match>
          <Match when={a().status === "notFound"}>
            Not installed. Install <code>{a().program}</code> and reopen Sway to pick it up.
          </Match>
          <Match when={a().version}>
            Ready, running the bundled adapter {a().adapterVersion} on {a().program}{" "}
            {a().version}.
          </Match>
          <Match when={true}>
            Ready, running the bundled adapter {a().adapterVersion}. {a().program} does not report a
            version, so Sway cannot check it.
          </Match>
        </Switch>
      </div>

      <div class={styles.chips}>
        <For each={a().extensions}>{(ext) => <span class={styles.chip}>.{ext}</span>}</For>
      </div>
    </div>
  );
}

export default function DapSection() {
  const [health] = createResource(() => invoke<DapHealth[]>("dap_health"));

  return (
    <section class={styles.section}>
      <div class={styles.sectionTitle}>
        <span>Debuggers</span>
        <span class={styles.sectionRule} />
      </div>
      <Switch>
        <Match when={health.loading}>
          <div class={styles.note}>Checking which debuggers are installed…</div>
        </Match>
        <Match when={health.error}>
          <div class={styles.note}>Could not check debuggers: {String(health.error)}</div>
        </Match>
        <Match when={health()}>
          <div class={styles.cardStack}>
            <For each={health()}>{(adapter) => <DapCard adapter={adapter} />}</For>
          </div>
          <div class={styles.note}>
            A language with no adapter still opens, edits and runs normally, it just cannot be
            debugged from here. The bundled adapter is fetched at build time by{" "}
            <code>pnpm dap:install</code>.
          </div>
        </Match>
      </Switch>
    </section>
  );
}

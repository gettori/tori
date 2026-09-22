import { For, Show, Switch, Match, createResource, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import Toggle from "../../../../components/Switch/Switch";
import { emitWith, TOAST, type ToastEvent } from "../../../../utils/events";
import { setDebuggerDisabled } from "../../settingsStore";
import styles from "../../Settings.module.css";

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
  adapterVersion: string | null;
  extensions: string[];
  detail: string | null;
  disabled: boolean;
  availableVersion: string | null;
  installedVersion: string | null;
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
  // Kept here because `dap_health` is not asked again after a save.
  const [turnedOff, setTurnedOff] = createSignal<boolean | null>(null);
  const off = () => turnedOff() ?? a().disabled;

  const use = (on: boolean) => {
    setTurnedOff(!on);
    setDebuggerDisabled(a().id, !on).catch((e) => {
      setTurnedOff(null);
      emitWith<ToastEvent>(TOAST, { message: `Could not turn ${on ? "on" : "off"} ${a().label}: ${String(e)}` });
    });
  };

  return (
    <div class={styles.toolCard}>
      <div class={styles.toolHead}>
        <span class={`${styles.dot} ${off() ? styles.dotOff : TONE[a().status]}`} />
        <span class={styles.toolName} classList={{ [styles.toolNameOff]: off() }}>
          {a().label}
        </span>
        <span class={styles.kindTag}>Debug</span>
        <Show when={off() || a().status !== "notFound"}>
          <Toggle class={styles.toolSwitch} checked={!off()} aria-label={`Use ${a().label}`} onChange={use} />
        </Show>
      </div>
      <code class={styles.toolProgram}>{a().program}</code>

      <div class={styles.toolStatus}>
        <Switch>
          {/* Most specific first: the bundle can be missing while `node` is
              present, and naming `node` there sends someone off installing
              something they already have. */}
          <Match when={off()}>
            Disabled by <code>dap.disabled</code> in settings.
          </Match>
          <Match when={a().detail}>{(detail) => <>{detail()}</>}</Match>
          <Match when={a().status === "notFound"}>
            Not installed. Install <code>{a().program}</code> and reopen Tori to pick it up.
          </Match>
          <Match when={a().version}>
            Ready, running the bundled adapter {a().adapterVersion} on {a().program}{" "}
            {a().version}.
          </Match>
          <Match when={true}>
            Ready, running the bundled adapter {a().adapterVersion}. {a().program} does not report a
            version, so Tori cannot check it.
          </Match>
        </Switch>
      </div>

      <div class={styles.toolExts}>
        <For each={a().extensions}>{(ext) => <span>.{ext}</span>}</For>
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
          <div class={styles.toolGrid}>
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

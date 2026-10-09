import { For, Show, Switch, Match, createResource, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import Toggle from "../../../../components/Switch/Switch";
import { emitWith, TOAST, type ToastEvent } from "../../../../utils/events";
import { setDebuggerDisabled } from "../../settingsStore";
import { onPacksChanged, type PackMeta } from "../../../../utils/packs";
import { createToolActions } from "./toolActions";
import styles from "../../Settings.module.css";
import NeedsFixing from "../../components/NeedsFixing";

// One card per debug adapter. The bundled one reads ready only when `node` and
// its bundle are both there, or every start fails while the card reads fine
// (lesson_the_handshake_succeeded_and_the_feature_is_silent).

type BinaryStatus = "notFound" | "versionUnknown" | "versionMatch" | "versionDrift";

export type DapHealth = PackMeta & {
  id: string;
  label: string;
  program: string;
  status: BinaryStatus;
  path: string | null;
  version: string | null;
  adapterVersion: string | null;
  verifiedAgainst: string | null;
  verifiedOn: string | null;
  verified: "checked" | "stated" | null;
  extensions: string[];
  detail: string | null;
  disabled: boolean;
  availableVersion: string | null;
  installedVersion: string | null;
  hint: string | null;
  update: string | null;
  uninstall: string | null;
};

// Same mapping as the LSP and agent cards: the dot answers "is this usable?"
// and nothing else, so `versionUnknown` is green.
const TONE: Record<BinaryStatus, string> = {
  versionMatch: styles.dotOk,
  versionUnknown: styles.dotOk,
  versionDrift: styles.dotWarn,
  notFound: styles.dotOff,
};

function DapCard(props: { adapter: DapHealth; onChange: () => Promise<DapHealth[] | null | undefined> }) {
  const a = () => props.adapter;
  const actions = createToolActions({
    tool: a,
    scope: "dap",
    onChange: () => props.onChange(),
    install: (adapterId) => invoke("dap_install", { adapterId }),
    remove: (adapterId) => invoke("dap_uninstall", { adapterId }),
  });
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
    <div class={styles.toolCard} classList={{ [styles.toolCardWide]: actions.job() !== null }}>
      <div class={styles.toolHead}>
        <span class={`${styles.dot} ${off() ? styles.dotOff : TONE[a().status]}`} />
        <span class={styles.toolName} classList={{ [styles.toolNameOff]: off() }}>
          {a().label}
        </span>
        <span class={styles.kindTag}>Debug</span>
        <span class={styles.toolControls}>
          <Show when={off() || a().status !== "notFound"}>
            <Toggle checked={!off()} aria-label={`Use ${a().label}`} onChange={use} />
          </Show>
          <actions.Controls />
        </span>
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
          <Match when={actions.pending() === "install"}>Installing {a().label}.</Match>
          <Match when={a().detail}>{(detail) => <>{detail()}</>}</Match>
          <Match when={a().installedVersion}>
            {(version) => (
              <>
                Installed by Tori, version {version()}.
                <Show when={actions.outdated()}> Version {a().availableVersion} is available.</Show>
              </>
            )}
          </Match>
          <Match when={actions.installable()}>
            Available, not installed. Tori can install version {a().availableVersion}.
          </Match>
          {/* The whole hint rather than just its command: Delve's also says
              where `go install` puts it, which the PATH may not include. */}
          <Match when={a().status === "notFound" && a().hint}>{(hint) => <>Not installed. {hint()}</>}</Match>
          <Match when={a().status === "notFound"}>
            Not installed. Install <code>{a().program}</code> and reopen Tori to pick it up.
          </Match>
          <Match when={a().adapterVersion && a().version}>
            Ready, running the bundled adapter {a().adapterVersion} on {a().program} {a().version}.
          </Match>
          <Match when={a().adapterVersion}>
            Ready, running the bundled adapter {a().adapterVersion}. {a().program} does not report a version, so Tori
            cannot check it.
          </Match>
          <Match when={a().version}>Installed, version {a().version}.</Match>
          <Match when={a().verified === "stated"}>
            Installed. Verified against {a().verifiedAgainst}, stated, not checked: {a().program} does not report a
            version.
          </Match>
          <Match when={true}>Installed. It does not report a version, so Tori cannot check it.</Match>
        </Switch>
      </div>

      <actions.Job />

      <div class={styles.toolExts}>
        <For each={a().extensions}>{(ext) => <span>.{ext}</span>}</For>
      </div>

      <actions.Confirm />
    </div>
  );
}

export default function DapSection() {
  const [health, { refetch }] = createResource(() => invoke<DapHealth[]>("dap_health"));
  onPacksChanged("dap", () => void refetch());

  return (
    <section class={styles.section}>
      <div class={styles.sectionTitle}>
        <span>Debuggers</span>
        <span class={styles.sectionRule} />
      </div>
      <NeedsFixing kind="dap" />
      <Switch>
        <Match when={health.state === "pending"}>
          <div class={styles.note}>Checking which debuggers are installed…</div>
        </Match>
        <Match when={health.error}>
          <div class={styles.note}>Could not check debuggers: {String(health.error)}</div>
        </Match>
        <Match when={health()}>
          <div class={styles.toolGrid}>
            <For each={health()}>
              {(adapter) => <DapCard adapter={adapter} onChange={() => Promise.resolve(refetch())} />}
            </For>
          </div>
          <div class={styles.note}>
            A language with no adapter still opens, edits and runs normally, it just cannot be debugged from here. Add
            one with a TOML file in <code>~/.config/tori/packs/dap/</code>; see DEBUGGERS.md.
          </div>
        </Match>
      </Switch>
    </section>
  );
}

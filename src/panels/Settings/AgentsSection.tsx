import { For, Show, Switch, Match, createResource } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import styles from "./Settings.module.css";

// One card per registered adapter, answering the question a new user actually
// has: "which of my agent CLIs does this thing work with?" The backend
// (`agent_health`) resolves each launch binary against the login-shell PATH,
// so an agent installed via nvm/asdf shows as found rather than missing.
//
// Tone matters here: a missing agent is not an error. Nobody has all three
// installed, so an uninstalled one gets an install hint, and an unparseable
// version gets neutral text - never red, never a warning icon.

type BinaryStatus = "notFound" | "versionUnknown" | "versionMatch" | "versionDrift";

export type AgentHealth = {
  id: string;
  label: string;
  program: string;
  status: BinaryStatus;
  path: string | null;
  version: string | null;
  verifiedAgainst: string | null;
  sessionsDir: string;
  sessionsDirExists: boolean;
  hooks: boolean;
  needsYou: boolean;
  contextWindow: boolean;
  overridePath: string | null;
};

// The dot answers one question - is this agent installed and usable? - and
// nothing else. `versionUnknown` is therefore green, not gray: an adapter
// carrying no `verified_against` (claude and pi today) says nothing about the
// user's install, and dimming two of three healthy agents over Sway's own
// missing bookkeeping reads as "these are worse off" when they are fine.
// Version detail belongs in the status text below, where it can be explained.
const TONE: Record<BinaryStatus, string> = {
  versionMatch: styles.dotOk,
  versionUnknown: styles.dotOk,
  versionDrift: styles.dotWarn,
  notFound: styles.dotOff,
};

function AgentCard(props: { agent: AgentHealth }) {
  const a = () => props.agent;
  return (
    <div class={styles.card}>
      <div class={styles.cardHead}>
        <span class={`${styles.dot} ${TONE[a().status]}`} />
        <span class={styles.cardTitle}>{a().label}</span>
        <code class={styles.cardProgram}>{a().program}</code>
      </div>

      <div class={styles.cardStatus}>
        <Switch>
          <Match when={a().status === "notFound"}>
            Not installed. Install <code>{a().program}</code> and reopen Sway to pick it up.
          </Match>
          <Match when={a().status === "versionMatch"}>Installed, version {a().version}.</Match>
          {/* Unknown covers two different situations, and saying "version not
              reported" for an agent that plainly reported one reads as a bug.
              Split on what we actually have. */}
          <Match when={a().status === "versionUnknown" && a().version}>
            Installed, version {a().version}.
          </Match>
          <Match when={a().status === "versionUnknown"}>
            Installed. It does not report a version, so Sway cannot check it.
          </Match>
          <Match when={a().status === "versionDrift"}>
            Installed, version {a().version}. Sway's adapter was built against{" "}
            {a().verifiedAgainst}, so some behaviour may differ.
          </Match>
        </Switch>
      </div>

      <div class={styles.cardMeta}>
        <Show
          when={a().sessionsDirExists}
          fallback={<>No sessions yet at <code>{a().sessionsDir}</code></>}
        >
          Sessions read from <code>{a().sessionsDir}</code>
        </Show>
      </div>

      <div class={styles.chips}>
        <Show when={a().hooks}>
          <span class={styles.chip} title="Status comes from the agent's own hooks">
            live status
          </span>
        </Show>
        <Show when={a().needsYou}>
          <span class={styles.chip} title="Sway can detect when this agent is waiting on you">
            needs-you
          </span>
        </Show>
        <Show when={a().contextWindow}>
          <span class={styles.chip} title="This adapter declares a context window size">
            context meter
          </span>
        </Show>
      </div>

      <Show when={a().overridePath}>
        {(path) => <div class={styles.hint}>Overridden by {path()}</div>}
      </Show>
    </div>
  );
}

export default function AgentsSection() {
  const [health] = createResource(() => invoke<AgentHealth[]>("agent_health"));

  return (
    <section class={styles.section}>
      <div class={styles.sectionTitle}>Agents</div>
      <Switch>
        <Match when={health.loading}>
          <div class={styles.hint}>Checking which agent CLIs are installed…</div>
        </Match>
        <Match when={health.error}>
          <div class={styles.hint}>Could not check agent CLIs: {String(health.error)}</div>
        </Match>
        <Match when={health()}>
          <For each={health()}>{(agent) => <AgentCard agent={agent} />}</For>
        </Match>
      </Switch>
    </section>
  );
}

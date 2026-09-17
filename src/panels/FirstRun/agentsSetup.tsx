import { Show, createEffect, createSignal, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { agentHealth, agentHealthFor, agentReady, ensureAgentHealthLoaded, refreshAgentHealth } from "../../utils/agentHealth";
import { agents, ensureAdaptersLoaded } from "../../utils/agents";
import { copyText } from "../../utils/clipboard";
import type { OpenJob } from "../../utils/events";
import { setupJob, type InstallRoute } from "../../utils/install";
import { loginJob, type LoginRoute } from "../../utils/signIn";
import InlineJob from "./job/InlineJob";
import type { JobState } from "./job/InlineJobFrame";
import AgentsStep from "./steps/AgentsStep";

type TerminalInstall = Extract<InstallRoute, { type: "terminal" }>;
type TerminalLogin = Extract<LoginRoute, { type: "terminal" }>;
type AgentJob = { job: OpenJob; agentId: string; verb: "install" | "signIn" };

/** A factory rather than a component, because the rest of the modal reads what
 *  it knows: whether a job is running, and which agents were found. */
export function createAgentsSetup(opts: { home: () => string; onScreen: () => boolean }) {
  const [installs, setInstalls] = createSignal<Record<string, TerminalInstall>>({});
  const [logins, setLogins] = createSignal<Record<string, TerminalLogin>>({});
  const [rechecking, setRechecking] = createSignal(false);
  const [job, setJob] = createSignal<AgentJob | null>(null);
  const [jobState, setJobState] = createSignal<JobState | null>(null);
  const running = () => jobState() === "running" || jobState() === "waiting";

  onMount(() => {
    ensureAgentHealthLoaded();
    void ensureAdaptersLoaded().then(loadRoutes);
  });

  // A job lives only while the step is on screen, and a job left here would
  // mount again, which runs it again, on the way back.
  createEffect(() => {
    if (!opts.onScreen()) clearJob();
  });

  async function loadRoutes() {
    const entries = await Promise.all(
      agents().map(async (a) => {
        const [install, login] = await Promise.all([
          invoke<InstallRoute>("agent_install_route", { adapterId: a.id }).catch(() => null),
          invoke<LoginRoute>("agent_login_route", { adapterId: a.id }).catch(() => null),
        ]);
        return {
          id: a.id,
          install: install?.type === "terminal" ? install : null,
          login: login?.type === "terminal" ? login : null,
        };
      }),
    );
    setInstalls(Object.fromEntries(entries.flatMap((e) => (e.install ? [[e.id, e.install]] : []))));
    setLogins(Object.fromEntries(entries.flatMap((e) => (e.login ? [[e.id, e.login]] : []))));
  }

  const label = (id: string) => agentHealthFor(id)?.label ?? id;
  const cwd = () => opts.home() || "/";

  function install(id: string) {
    const route = installs()[id];
    const next = route && setupJob("install", id, label(id), route, cwd());
    if (next) setJob({ job: next, agentId: id, verb: "install" });
  }

  // The default profile, as on the agent's Settings page: this step is about
  // making the agent usable at all, which the default account decides.
  function signIn(id: string) {
    const route = logins()[id];
    const next = route && loginJob(id, label(id), "default", "Default", route, cwd());
    if (next) setJob({ job: next, agentId: id, verb: "signIn" });
  }

  // Read off the re-probe the job waits for, not off the exit code: a package
  // manager can finish cleanly into a bin directory the login shell never looks
  // in, and a login can exit 0 without leaving anyone signed in.
  function okLine(j: AgentJob): string {
    const h = agentHealthFor(j.agentId);
    const name = label(j.agentId);
    if (j.verb === "install") {
      if (h && h.status !== "notFound") return `${name}${h.version ? ` ${h.version}` : ""} installed`;
      return `Install finished, but Tori still cannot find ${h?.program ?? j.agentId} on your login shell's PATH`;
    }
    if (h?.signIn === "signedOut") return `Sign-in finished, but ${name} still reports signed out`;
    return `Signed in to ${name}`;
  }

  function clearJob() {
    setJob(null);
    setJobState(null);
  }

  async function checkAgain() {
    setRechecking(true);
    try {
      await refreshAgentHealth();
    } finally {
      setRechecking(false);
    }
  }

  const tally = () => {
    const found = (agentHealth() ?? []).filter((h) => h.status !== "notFound");
    return {
      found: found.length,
      ready: found.filter((h) => agentReady(h.id)).length,
      signedIn: found.filter((h) => h.signIn === "signedIn").map((h) => h.label),
    };
  };

  const summary = () => {
    if (!agentHealth()) return null;
    const { found } = tally();
    return found > 0 ? `${found} found` : "none found";
  };

  const view = () => (
    <AgentsStep
      health={agentHealth()}
      checking={rechecking()}
      installs={installs()}
      terminalLogins={Object.keys(logins())}
      busy={running()}
      onInstall={install}
      onSignIn={signIn}
      onCopy={copyText}
      onCheckAgain={() => void checkAgain()}
      job={
        <Show when={job()} keyed>
          {(j) => <InlineJob job={j.job} okLine={okLine(j)} onCancel={clearJob} onState={setJobState} />}
        </Show>
      }
    />
  );

  return { view, running, summary, tally };
}

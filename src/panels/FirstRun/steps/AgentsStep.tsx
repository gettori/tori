import { For, Index, Match, Show, Switch, createSignal, type JSX } from "solid-js";
import Button from "../../../components/Button/Button";
import AgentGlyph from "../../../components/Icon/AgentGlyph";
import type { AgentHealth } from "../../../utils/agentHealth";
import { verifiedVersion } from "../../../utils/versions";
import styles from "../FirstRun.module.css";

export const AGENTS_LEAD =
  "Tori drives agent CLIs installed on this machine, so it needs at least one to start a session. It does not bundle an agent of its own.";

export type Command = { program: string; args: string[] };

export const commandLine = (c: Command) => [c.program, ...c.args].join(" ");

export default function AgentsStep(props: {
  /** Null until the first probe answers. */
  health: AgentHealth[] | null;
  checking?: boolean;
  installs: Record<string, Command>;
  terminalLogins: string[];
  /** A job is running, so nothing may start a second one. */
  busy?: boolean;
  onInstall: (id: string) => void;
  onSignIn: (id: string) => void;
  onCopy: (text: string) => Promise<boolean>;
  onCheckAgain: () => void;
  job?: JSX.Element;
}) {
  const [otherOpen, setOtherOpen] = createSignal(false);
  const [copied, setCopied] = createSignal<string | null>(null);

  async function copy(id: string, text: string) {
    if (!(await props.onCopy(text))) return;
    setCopied(id);
    setTimeout(() => setCopied((now) => (now === id ? null : now)), 1500);
  }

  const all = () => props.health ?? [];
  const found = () => all().filter((h) => h.status !== "notFound");
  const installable = () => all().filter((h) => h.status === "notFound" && props.installs[h.id]);
  const shown = () => (found().length > 0 ? found() : installable());
  const others = () => all().filter((h) => !shown().includes(h));

  const probing = () => props.health === null || !!props.checking;

  return (
    <>
      <Show
        when={!probing()}
        fallback={
          <>
            <div class={styles.agents}>
              <Index each={[130, 104, 120]}>
                {(width) => (
                  <div class={`${styles.agent} ${styles.skeleton}`}>
                    <span class={styles.agentPlate} />
                    <span class={styles.bar} style={{ "--bar": String(width()) }} />
                    <span class={`${styles.bar} ${styles.barEnd}`} />
                  </div>
                )}
              </Index>
            </div>
            <div class={styles.probing}>Probing PATH for known agent CLIs</div>
          </>
        }
      >
        <div class={styles.agents}>
          <For each={shown()}>
            {(h) => (
              <div class={styles.agent}>
                <span class={styles.agentPlate}>
                  <AgentGlyph id={h.id} label={h.label} size={20} />
                </span>
                <span class={styles.agentText}>
                  <span class={styles.agentName}>{h.label}</span>
                  <Switch>
                    <Match when={h.status === "notFound" && props.installs[h.id]}>
                      {(cmd) => <span class={styles.agentLine}>{commandLine(cmd())}</span>}
                    </Match>
                    <Match when={h.status === "versionDrift" && h.verifiedAgainst}>
                      <span class={`${styles.agentLine} ${styles.agentDrift}`}>
                        {h.program} {h.version}, tested against {verifiedVersion(h.verifiedAgainst)}
                      </span>
                    </Match>
                    <Match when={true}>
                      <span class={styles.agentLine}>
                        {h.program}
                        {h.version ? ` ${h.version}` : ""}
                      </span>
                    </Match>
                  </Switch>
                </span>
                <span class={styles.agentEnd}>
                  <Switch>
                    <Match when={h.status === "notFound" && props.installs[h.id]}>
                      {(cmd) => (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => void copy(h.id, commandLine(cmd()))}>
                            {copied() === h.id ? "Copied" : "Copy"}
                          </Button>
                          <Button size="sm" disabled={props.busy} onClick={() => props.onInstall(h.id)}>
                            Install
                          </Button>
                        </>
                      )}
                    </Match>
                    <Match when={h.signIn === "signedIn"}>
                      <span class={styles.signedIn}>{h.account ? `Signed in as ${h.account}` : "Signed in"}</span>
                    </Match>
                    <Match when={h.signIn === "signedOut" && props.terminalLogins.includes(h.id)}>
                      <Button size="sm" disabled={props.busy} onClick={() => props.onSignIn(h.id)}>
                        Sign in
                      </Button>
                    </Match>
                    <Match when={h.signIn === "signedOut"}>
                      <span class={styles.hint}>Signed out</span>
                    </Match>
                  </Switch>
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Outside the Show: a re-probe must not unmount a job, which would kill
          a running one and re-run a finished one. */}
      {props.job}

      <Show when={!probing() && others().length > 0}>
        <div class={styles.others}>
          <button
            type="button"
            class={styles.othersToggle}
            aria-expanded={otherOpen()}
            onClick={() => setOtherOpen((open) => !open)}
          >
            Other supported agents
            <span class={styles.othersCount}>{otherOpen() ? "Hide" : `${others().length} more`}</span>
          </button>
          <Show when={otherOpen()}>
            <div class={styles.othersList}>
              <For each={others()}>
                {(h) => (
                  <div class={styles.othersRow}>
                    <span>{h.program}</span>
                    <span>not installed</span>
                  </div>
                )}
              </For>
              <div class={styles.othersNote}>Anything else: add a TOML adapter in Settings &gt; Agents.</div>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={!probing() && found().length === 0}>
        <div class={styles.row}>
          <button type="button" class={styles.link} disabled={props.busy} onClick={() => props.onCheckAgain()}>
            Check again
          </button>
          <span class={styles.hint}>Sessions need an agent. You can finish this later in Settings &gt; Agents.</span>
        </div>
      </Show>
    </>
  );
}

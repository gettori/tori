import { For, Show, createMemo, createResource, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { ChatAccount, McpServer } from "../../utils/chatTypes";
import type { ChatPlugin, PublishedCapability } from "../../utils/chatCapabilities";
import Button from "../../components/Button/Button";
import styles from "./Chat.module.css";

/** One server as Claude's own config files declare it, across the three scopes
 *  (`chat_mcp_list`). Distinct from `McpServer`, which is what `system/init`
 *  reports about the servers the *running* session actually loaded. */
type McpEntry = {
  name: string;
  scope: "user" | "project" | "local";
  approval: "approved" | "pending" | "disabled" | "notApplicable";
  config: unknown;
};

/** A server's status as `system/init` words it, mapped to whether it is a
 *  problem. The agent's own vocabulary is passed through to the user rather
 *  than translated: "failed" and "needs-auth" mean different things to act on. */
function isBroken(status: string): boolean {
  return status !== "connected";
}

/**
 * What this session loaded: MCP servers, skills, subagents and plugins.
 *
 * Collapsed by default. This answers a question the user asks occasionally
 * ("is my MCP server actually connected?") and never during a conversation, so
 * it earns a disclosure rather than permanent space above the transcript.
 *
 * The counts live in the summary so the answer to "did anything fail" is
 * visible without opening it.
 */
export default function SessionInfo(props: {
  mcpServers: readonly McpServer[];
  skills: readonly string[];
  agents: readonly string[];
  plugins: readonly ChatPlugin[];
  /** Who the session is signed in as, or null when the handshake never
   *  happened. Rendered here rather than in the status strip: the strip's stats
   *  row is fed by a transcript scan on its own refresh cadence, and mixing a
   *  handshake fact into it would put two sources behind one row.
   *
   *  Required, unlike `cwd`: absence is the meaning here, so an omittable prop
   *  would let "nobody passed it" render identically to "we were never told". */
  account: ChatAccount | null;
  /** What this chat can actually do, published from the transport's tier plus
   *  whatever the running agent advertised about itself.
   *
   *  Rendered per *session* rather than only on the Agents cards in Settings,
   *  because for a generic transport it is a per-session fact: two ACP agents
   *  behind one transport answer differently, and so can one agent before and
   *  after its user signs into another provider. */
  capabilities: readonly PublishedCapability[];
  /** The session's cwd, used to locate the project `.mcp.json`. Omitted in
   *  tests that only exercise the read-only rendering. */
  cwd?: string;
}) {
  const [open, setOpen] = createSignal(false);
  const [adding, setAdding] = createSignal(false);
  const [name, setName] = createSignal("");
  const [command, setCommand] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);

  // Only fetched once the panel is open: this reads two files off disk, and a
  // collapsed panel has nothing to show for them.
  const [configured, { mutate }] = createResource(
    () => (open() && props.cwd ? props.cwd : null),
    (cwd) => invoke<McpEntry[]>("chat_mcp_list", { cwd }),
  );

  /** Split the typed command on whitespace: the first word is the program, the
   *  rest its args, matching `claude mcp add <name> -- <command> <args...>`. */
  async function addServer(e: Event) {
    e.preventDefault();
    const [program, ...args] = command().trim().split(/\s+/).filter(Boolean);
    if (!name().trim() || !program) {
      setError("A server needs a name and a command.");
      return;
    }
    setError(null);
    try {
      const next = await invoke<McpEntry[]>("chat_mcp_add", {
        cwd: props.cwd,
        name: name().trim(),
        config: { command: program, args },
      });
      mutate(next);
      setName("");
      setCommand("");
      setAdding(false);
    } catch (err) {
      setError(String(err));
    }
  }

  async function removeServer(serverName: string) {
    setError(null);
    try {
      mutate(await invoke<McpEntry[]>("chat_mcp_remove", { cwd: props.cwd, name: serverName }));
    } catch (err) {
      setError(String(err));
    }
  }
  const broken = createMemo(() => props.mcpServers.filter((s) => isBroken(s.status)));
  // A session with a cwd is never "empty": even with nothing loaded, the panel
  // is the only route to adding an MCP server, and a project with none is
  // exactly the case where someone wants to.
  const empty = createMemo(
    () =>
      !props.cwd &&
      !props.account &&
      props.capabilities.length === 0 &&
      props.mcpServers.length === 0 &&
      props.skills.length === 0 &&
      props.agents.length === 0 &&
      props.plugins.length === 0,
  );

  return (
    <Show when={!empty()}>
      <div class={styles.sessionInfo}>
        <button
          type="button"
          class={styles.sessionInfoToggle}
          aria-expanded={open()}
          onClick={() => setOpen(!open())}
        >
          Session
          <Show when={props.mcpServers.length}>{(n) => <span> · {n()} MCP</span>}</Show>
          {/* Surfaced in the summary because a broken server is the whole
              reason someone opens this. */}
          <Show when={broken().length}>
            {(n) => <span class={styles.sessionInfoBad}> · {n()} not connected</span>}
          </Show>
          <Show when={props.skills.length}>{(n) => <span> · {n()} skills</span>}</Show>
        </button>
        <Show when={open()}>
          <div class={styles.sessionInfoBody}>
            {/* Only when the handshake answered. A session that never
                handshook shows no Account section at all rather than a blank
                one or a guessed tier: "we were never told" is not a plan. Each
                line is guarded separately for the same reason, since the
                agent can name an account without naming an organization. */}
            <Show when={props.account}>
              {(a) => (
                <section>
                  <h4>Account</h4>
                  <p>
                    <Show when={a().subscriptionType}>{(plan) => <strong>{plan()}</strong>}</Show>
                    {/* The separator belongs to whichever line is not first, so
                        it is conditioned on both: an account naming only an
                        organization must not open with a stray "·". */}
                    <Show when={a().organization}>
                      {(org) => (
                        <span>
                          {a().subscriptionType ? " · " : ""}
                          {org()}
                        </span>
                      )}
                    </Show>
                  </p>
                </section>
              )}
            </Show>
            {/* What this chat can do, in the same panel as what it loaded,
                because both answer "what am I working with". Each entry is the
                *qualified* value: a row reading "rewind" would promise the
                unqualified capability, and an affordance this agent lacks is
                absent rather than listed as `none`. */}
            <Show when={props.capabilities.length}>
              <section>
                <h4>Chat capabilities</h4>
                <p>
                  <For each={props.capabilities}>
                    {(cap, i) => (
                      <>
                        {i() > 0 ? " · " : ""}
                        <code>{cap.label}</code>
                      </>
                    )}
                  </For>
                </p>
              </section>
            </Show>
            <Show when={props.mcpServers.length}>
              <section>
                <h4>MCP servers</h4>
                <ul>
                  <For each={props.mcpServers}>
                    {(s) => (
                      <li class={isBroken(s.status) ? styles.sessionInfoBad : undefined}>
                        <strong>{s.name}</strong> · {s.status}
                        {/* Only when the agent reported one: a server that
                            declares no tool count must not read as zero tools.
                            The count is read from `s`, not from the `Show`
                            callback, which carries the boolean rather than the
                            number - and a server with 0 tools must still say so,
                            so the guard cannot be a truthiness check either. */}
                        <Show when={s.toolCount !== null}>
                          <span> · {s.toolCount} tools</span>
                        </Show>
                        <Show when={s.error}>{(e) => <div>{e()}</div>}</Show>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>
            <Show when={props.cwd}>
              <section>
                <h4>Configured MCP servers</h4>
                <ul>
                  <For each={configured()}>
                    {(e) => (
                      <li>
                        <strong>{e.name}</strong> · {e.scope}
                        {/* Only a `.mcp.json` server can be pending, and it is
                            not connected to until approved. Sway deliberately
                            does not force-enable it: the approval lives in
                            Claude's own state file, which we never write. */}
                        <Show when={e.approval === "pending"}>
                          <span class={styles.sessionInfoBad}> · pending approval (run `claude` to approve)</span>
                        </Show>
                        <Show when={e.approval === "disabled"}>
                          <span class={styles.sessionInfoBad}> · disabled</span>
                        </Show>
                        {/* Only project servers live in the file Sway writes. */}
                        <Show when={e.scope === "project"}>
                          <Button size="xs" variant="ghost" onClick={() => void removeServer(e.name)}>
                            Remove
                          </Button>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
                <Show when={error()}>{(msg) => <div class={styles.sessionInfoBad}>{msg()}</div>}</Show>
                <Show
                  when={adding()}
                  fallback={
                    <Button size="xs" onClick={() => setAdding(true)}>
                      Add server
                    </Button>
                  }
                >
                  <form onSubmit={addServer}>
                    <input
                      placeholder="name"
                      value={name()}
                      onInput={(ev) => setName(ev.currentTarget.value)}
                    />
                    <input
                      placeholder="npx -y @scope/server"
                      value={command()}
                      onInput={(ev) => setCommand(ev.currentTarget.value)}
                    />
                    <Button size="xs" type="submit">
                      Save
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => (setAdding(false), setError(null))}>
                      Cancel
                    </Button>
                  </form>
                </Show>
                <p>Written to this project's .mcp.json, the same file `claude mcp add --scope project` uses.</p>
              </section>
            </Show>
            <Show when={props.skills.length}>
              <section>
                <h4>Skills</h4>
                <p>{props.skills.join(", ")}</p>
              </section>
            </Show>
            <Show when={props.agents.length}>
              <section>
                <h4>Agents</h4>
                <p>{props.agents.join(", ")}</p>
              </section>
            </Show>
            <Show when={props.plugins.length}>
              <section>
                <h4>Plugins</h4>
                <ul>
                  <For each={props.plugins}>
                    {(p) => (
                      <li>
                        <strong>{p.name}</strong>
                        <Show when={p.version}>{(v) => <span> · {v()}</span>}</Show>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
}

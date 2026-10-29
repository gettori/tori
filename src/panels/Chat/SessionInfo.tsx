import { For, Show, createMemo, createResource, createSignal, type JSX } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { ChatAccount, McpServer } from "../../utils/chatTypes";
import type { ChatPlugin, PublishedCapability } from "../../utils/chatCapabilities";
import { ChevronRight, Plus } from "lucide-solid";
import Button from "../../components/Button/Button";
import Icon from "../../components/Icon/Icon";
import Tooltip from "../../components/Tooltip/Tooltip";
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

const NEEDS_AUTH = "needs-auth";

const OWN_SKILLS = "Project & user";

// A plugin's skills arrive as `plugin:skill`; the rest are the project's and the user's own.
function skillGroups(skills: readonly string[]): { name: string; skills: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const skill of skills) {
    const at = skill.indexOf(":");
    const [group, name] = at > 0 ? [skill.slice(0, at), skill.slice(at + 1)] : [OWN_SKILLS, skill];
    groups.set(group, [...(groups.get(group) ?? []), name]);
  }
  return [...groups.entries()]
    .map(([name, skills]) => ({ name, skills }))
    .sort((a, b) => Number(a.name === OWN_SKILLS) - Number(b.name === OWN_SKILLS) || a.name.localeCompare(b.name));
}

function Fold(props: { label: string; count: number; open?: boolean; children: JSX.Element }) {
  const [open, setOpen] = createSignal(!!props.open);
  return (
    <div>
      <button type="button" class={styles.detailsFold} aria-expanded={open()} onClick={() => setOpen(!open())}>
        <Icon icon={ChevronRight} />
        <span class={styles.detailsFoldLabel}>{props.label}</span>
        <span class={styles.detailsCount}>{props.count}</span>
      </button>
      <Show when={open()}>{props.children}</Show>
    </div>
  );
}

function Chips(props: { items: readonly string[] }) {
  return (
    <div class={styles.detailsChips}>
      <For each={props.items}>{(item) => <code class={styles.detailsChip}>{item}</code>}</For>
    </div>
  );
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
  /** Which agent and which of its accounts this session runs as. Both are
   *  needed to locate the user-scope `.claude.json`, which lives inside an
   *  isolated home rather than beside it. */
  agentId?: string;
  profile?: string | null;
  /** The user's name for that account, already resolved, or null when naming
   *  it would say nothing (a single-account install). Resolved by the caller so
   *  this component stays a renderer and its tests need no health sweep. */
  profileLabel?: string | null;
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
    (cwd) =>
      invoke<McpEntry[]>("chat_mcp_list", {
        cwd,
        agentId: props.agentId ?? "claude",
        profile: props.profile ?? null,
      }),
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
        agentId: props.agentId ?? "claude",
        profile: props.profile ?? null,
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
      mutate(
        await invoke<McpEntry[]>("chat_mcp_remove", {
          cwd: props.cwd,
          name: serverName,
          agentId: props.agentId ?? "claude",
          profile: props.profile ?? null,
        }),
      );
    } catch (err) {
      setError(String(err));
    }
  }
  const needAuth = createMemo(() => props.mcpServers.filter((s) => s.status === NEEDS_AUTH));
  const down = createMemo(() => props.mcpServers.filter((s) => isBroken(s.status) && s.status !== NEEDS_AUTH));
  const configOf = (name: string) => configured()?.find((e) => e.name === name);
  // Declared in a config file but never loaded: pending approval, disabled, or new since the session started.
  const unloaded = createMemo(() =>
    (configured() ?? []).filter((e) => !props.mcpServers.some((s) => s.name === e.name)),
  );
  const connected = () => props.mcpServers.filter((s) => !isBroken(s.status)).length;
  const groups = createMemo(() => skillGroups(props.skills));
  // A session with a cwd is never "empty": even with nothing loaded, the panel
  // is the only route to adding an MCP server, and a project with none is
  // exactly the case where someone wants to.
  const empty = createMemo(
    () =>
      !props.cwd &&
      !props.account &&
      !props.profileLabel &&
      props.capabilities.length === 0 &&
      props.mcpServers.length === 0 &&
      props.skills.length === 0 &&
      props.agents.length === 0 &&
      props.plugins.length === 0,
  );

  const remove = (name: string) => (
    <Show when={configOf(name)?.scope === "project"}>
      <Button size="xs" variant="ghost" class={styles.detailsRemove} onClick={() => void removeServer(name)}>
        Remove
      </Button>
    </Show>
  );

  return (
    <Show when={!empty()}>
      <div class={styles.sessionInfo}>
        <button type="button" class={styles.sessionInfoToggle} aria-expanded={open()} onClick={() => setOpen(!open())}>
          <span class={styles.sessionInfoText}>
            <span class={styles.sessionInfoTitle}>Session details</span>
            <span class={styles.sessionInfoSummary}>
              {/* First, because a server that is not connected is the whole
                  reason someone opens this. */}
              <Show when={needAuth().length}>
                {(n) => (
                  <span class={styles.sessionInfoWarn}>
                    <span class={styles.detailsDot} aria-hidden="true" />
                    {n()} need sign-in
                  </span>
                )}
              </Show>
              <Show when={down().length}>{(n) => <span class={styles.sessionInfoBad}>{n()} not connected</span>}</Show>
              <Show when={props.mcpServers.length}>{(n) => <span>{n()} MCP</span>}</Show>
              <Show when={props.skills.length}>{(n) => <span>{n()} skills</span>}</Show>
            </span>
          </span>
          <Icon icon={ChevronRight} />
        </button>
        <Show when={open()}>
          <div class={styles.detailsPanel} role="region" aria-label="Session details">
            {/* Every line is guarded on its own: the two sources answer at
                different moments and can each say nothing. A session that never
                handshook shows no plan ("we were never told" is not a plan),
                while the account's name is known before it starts. */}
            <Show when={props.profileLabel || props.account}>
              <div class={styles.detailsAccount}>
                <div class={styles.detailsAccountLine}>
                  <Show when={props.account?.subscriptionType}>
                    {(plan) => <span class={styles.detailsPlan}>{plan()}</span>}
                  </Show>
                  <Show when={props.profileLabel}>{(name) => <span>{name()}</span>}</Show>
                </div>
                <Show when={props.account?.organization}>
                  {(org) => <div class={styles.detailsMuted}>{org()}</div>}
                </Show>
              </div>
            </Show>

            <Show when={props.mcpServers.length || props.cwd}>
              <section class={styles.detailsSection}>
                <div class={styles.detailsHeading}>
                  <span>MCP servers</span>
                  <Show when={props.mcpServers.length + unloaded().length}>
                    {(total) => (
                      <span class={styles.detailsCount}>
                        {connected()} of {total()} connected
                      </span>
                    )}
                  </Show>
                </div>
                <For each={props.mcpServers}>
                  {(s) => (
                    <div class={styles.detailsServer}>
                      <div class={styles.detailsRow}>
                        <span
                          class={styles.detailsDot}
                          classList={{
                            [styles.detailsDotOk]: !isBroken(s.status),
                            [styles.detailsDotWarn]: s.status === NEEDS_AUTH,
                            [styles.detailsDotBad]: isBroken(s.status) && s.status !== NEEDS_AUTH,
                          }}
                          aria-hidden="true"
                        />
                        <span class={styles.detailsName}>{s.name}</span>
                        {remove(s.name)}
                        {/* A server that declares no tool count must not read as
                            zero tools, and one with 0 must still say so, so the
                            guard is on null rather than on truthiness. */}
                        <Show
                          when={!isBroken(s.status)}
                          fallback={
                            <Show
                              when={s.status === NEEDS_AUTH}
                              fallback={<span class={styles.sessionInfoBad}>{s.status}</span>}
                            >
                              <span class={styles.detailsPill}>Needs sign-in</span>
                            </Show>
                          }
                        >
                          <span class={styles.detailsMuted}>
                            {s.toolCount !== null ? `${s.toolCount} tools` : "Connected"}
                          </span>
                        </Show>
                      </div>
                      <Show when={s.error}>{(e) => <div class={styles.detailsError}>{e()}</div>}</Show>
                    </div>
                  )}
                </For>
                <For each={unloaded()}>
                  {(e) => (
                    <div class={styles.detailsRow}>
                      <span class={styles.detailsDot} aria-hidden="true" />
                      <span class={styles.detailsName}>{e.name}</span>
                      {remove(e.name)}
                      {/* Only a `.mcp.json` server can be pending, and it is not
                          connected to until approved. Tori deliberately does not
                          force-enable it: the approval lives in Claude's own
                          state file, which we never write. */}
                      <span classList={{ [styles.sessionInfoWarn]: e.approval !== "approved" }}>
                        {e.approval === "pending"
                          ? "pending approval (run `claude` to approve)"
                          : e.approval === "disabled"
                            ? "disabled"
                            : e.scope}
                      </span>
                    </div>
                  )}
                </For>
                <Show when={props.cwd}>
                  <Show when={error()}>{(msg) => <div class={styles.detailsError}>{msg()}</div>}</Show>
                  <Show
                    when={adding()}
                    fallback={
                      <button type="button" class={styles.detailsAdd} onClick={() => setAdding(true)}>
                        <Icon icon={Plus} />
                        <span class={styles.detailsName}>Add server</span>
                        <Tooltip
                          as="span"
                          class={styles.detailsCount}
                          label="Written to this project's .mcp.json, the same file `claude mcp add --scope project` uses."
                        >
                          .mcp.json
                        </Tooltip>
                      </button>
                    }
                  >
                    <form class={styles.detailsForm} onSubmit={addServer}>
                      <input placeholder="name" value={name()} onInput={(ev) => setName(ev.currentTarget.value)} />
                      <input
                        placeholder="npx -y @scope/server"
                        value={command()}
                        onInput={(ev) => setCommand(ev.currentTarget.value)}
                      />
                      <div class={styles.detailsFormActions}>
                        <Button size="xs" variant="ghost" onClick={() => (setAdding(false), setError(null))}>
                          Cancel
                        </Button>
                        <Button size="xs" type="submit">
                          Save
                        </Button>
                      </div>
                    </form>
                  </Show>
                </Show>
              </section>
            </Show>

            <Show when={props.skills.length}>
              <section class={styles.detailsSection}>
                <div class={styles.detailsHeading}>
                  <span>Skills</span>
                  <span class={styles.detailsCount}>{props.skills.length}</span>
                </div>
                <For each={groups()}>
                  {(group, i) => (
                    <Fold label={group.name} count={group.skills.length} open={i() === 0}>
                      <Chips items={group.skills} />
                    </Fold>
                  )}
                </For>
              </section>
            </Show>

            <Show when={props.plugins.length}>
              <section class={styles.detailsSection}>
                <div class={styles.detailsHeading}>
                  <span>Plugins</span>
                  <span class={styles.detailsCount}>{props.plugins.length}</span>
                </div>
                <For each={props.plugins}>
                  {(p) => (
                    <div class={styles.detailsRow}>
                      <span class={styles.detailsName}>{p.name}</span>
                      <Show when={p.version}>{(v) => <span class={styles.detailsCount}>{v()}</span>}</Show>
                    </div>
                  )}
                </For>
              </section>
            </Show>

            <Show when={props.agents.length || props.capabilities.length}>
              <section class={styles.detailsSection}>
                <Show when={props.agents.length}>
                  <Fold label="Agents" count={props.agents.length}>
                    <Chips items={props.agents} />
                  </Fold>
                </Show>
                {/* What this chat can do, beside what it loaded, because both
                    answer "what am I working with". Each entry is the qualified
                    value: a bare "rewind" would promise the unqualified
                    capability, and an affordance this agent lacks is absent
                    rather than listed as `none`. */}
                <Show when={props.capabilities.length}>
                  <Fold label="Chat capabilities" count={props.capabilities.length}>
                    <Chips items={props.capabilities.map((c) => c.label)} />
                  </Fold>
                </Show>
              </section>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
}

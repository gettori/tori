import { For, Show, createEffect, createResource, createSignal, on, onCleanup } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { ArrowUp, ChevronLeft, Ellipsis, Paperclip, X } from "lucide-solid";
import Icon from "../../src/components/Icon/Icon";
import MessageList from "../../src/panels/Chat/MessageList";
import PlanCard from "../../src/panels/Chat/PlanCard";
import type { HunkRef } from "../../src/panels/Chat/ToolCallCard";
import { fmtCost, fmtTokens } from "../../src/utils/chatUsage";
import { contextPercent, contextWindowFor } from "../../src/utils/chatModels";
import {
  applyEvent,
  initialChat,
  isRunning,
  settleBackfill,
  turnModel,
  planStale,
  type ChatState,
} from "../../src/panels/Chat/chatStore";
import { parseChatEvent, type ChatConfigOption, type ChatEffortLevel, type ChatEvent } from "../../src/utils/chatTypes";
import AskSheet, { type Ask } from "./AskSheet";
import ChangesSheet from "./Changes";
import { createAttachments, labels } from "./attach";
import Pending, { type PendingRow } from "./Pending";
import type { RemoteClient } from "./remote";
import { DOT, PhaseMark } from "./Root";
import { AgentMark } from "./Unit";
import { PHASE_LABEL, phaseOf, type Phase, type SessionRow } from "./tree";
import styles from "./mobile.module.css";
import shell from "./shell.module.css";

const HISTORY_TURNS = 5;
// A page can hold 500 events, slow over mobile data; the default timeout would
// drop the socket and reload it forever.
const HISTORY_REPLY_MS = 30_000;

type Page = { events: unknown[]; next: unknown };

// A prompt raised or settled moves one of these; none says which, so any of them
// refetches the whole pending list.
const PENDING_KINDS = new Set([
  "session.question",
  "session.permission",
  "session.needs_you",
  "session.state",
  "session.turn_ended",
]);

const NEXT = "\u203a";

type Info = {
  model: string | null;
  permission_mode: string | null;
  models: { value: string; resolvedModel: string; displayName: string; effortLevels?: ChatEffortLevel[] }[];
  modes: { id: string; label: string; permissive?: boolean }[];
};

// A switch is confirmed only by the next turn, so the pick is shown until
// `session.info` moves off the value it had when the pick was made.
type Pick = { value: string; over: string | null };

function parsed(raw: unknown[]): ChatEvent[] {
  return raw.map(parseChatEvent).filter((ev): ev is ChatEvent => ev !== null);
}

const tail = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

function Levers(props: {
  client: RemoteClient;
  id: string;
  agent: string | undefined;
  refused: Record<string, string>;
  effort: string | null;
  config: ChatConfigOption[];
  onError: (message: string) => void;
}) {
  const [info, { refetch }] = createResource<Info | null, number>(
    () => props.client.generation() || undefined,
    () => props.client.request<Info>("session.info", { id: props.id }).catch(() => null),
  );
  const [model, setModel] = createSignal<Pick | null>(null);
  const [mode, setMode] = createSignal<Pick | null>(null);
  onCleanup(
    props.client.subscribe(`session:${props.id}`, (data) => {
      if ((data as { kind?: string } | null)?.kind === "session.state") void refetch();
    }),
  );
  onCleanup(
    props.client.subscribe("sessions", (data) => {
      const ev = data as { kind?: string; id?: string } | null;
      if (ev?.kind === "session.started" && ev.id === props.id) void refetch();
    }),
  );
  const shown = (pick: Pick | null, confirmed: string | null) =>
    pick && pick.over === confirmed ? pick.value : confirmed;
  const models = () => info()?.models ?? [];
  const modes = () => info()?.modes ?? [];
  const currentModel = () => {
    const value = shown(model(), info()?.model ?? null);
    return models().find((m) => m.value === value) ?? models().find((m) => m.resolvedModel === value) ?? null;
  };
  const modelValue = () => currentModel()?.value ?? shown(model(), info()?.model ?? null) ?? "";
  const modeValue = () => {
    const pick = mode();
    return shown(pick && props.refused[pick.value] === undefined ? pick : null, info()?.permission_mode ?? null) ?? "";
  };
  const currentMode = () => modes().find((m) => m.id === modeValue());
  const [effort, setEffort] = createSignal<string | null>(null);
  const efforts = () => (currentModel()?.effortLevels ?? []).filter((l) => !l.disabled);
  const effortValue = () => effort() ?? props.effort ?? "";
  const pickEffort = (level: string) =>
    props.client
      .request("session.model", { id: props.id, model: modelValue(), effort: level })
      .then(() => setEffort(level))
      .catch((e: Error) => props.onError(e.message));
  const setOption = (configId: string, value: string | boolean) =>
    props.client
      .request("session.call", { id: props.id, op: "set_config_option", args: { config_id: configId, value } })
      .catch((e: Error) => props.onError(e.message));

  const pick = (method: "session.model" | "session.mode", value: string) => {
    const over = method === "session.model" ? (info()?.model ?? null) : (info()?.permission_mode ?? null);
    props.client
      .request(method, method === "session.model" ? { id: props.id, model: value } : { id: props.id, mode: value })
      .then(() => (method === "session.model" ? setModel : setMode)({ value, over }))
      .catch((e: Error) => props.onError(e.message));
  };

  return (
    <>
      <label class={shell.chip}>
        <AgentMark agent={props.agent} size={13} />
        {currentModel()?.displayName || modelValue() || "Model"}
        <select
          value={modelValue()}
          disabled={models().length === 0}
          onChange={(e) => pick("session.model", e.currentTarget.value)}
        >
          <Show when={!currentModel() && modelValue()}>
            <option value={modelValue()}>{modelValue()}</option>
          </Show>
          <For each={models()}>{(m) => <option value={m.value}>{m.displayName || m.value}</option>}</For>
        </select>
      </label>
      <Show when={modes().length > 0}>
        <label class={shell.chip} data-permissive={currentMode()?.permissive === true}>
          {currentMode()?.label ?? (modeValue() || "Mode")}
          <select value={modeValue()} onChange={(e) => pick("session.mode", e.currentTarget.value)}>
            <Show when={!currentMode()}>
              <option value={modeValue()}>{modeValue() || "Mode"}</option>
            </Show>
            <For each={modes()}>
              {(m) => (
                <option value={m.id} disabled={props.refused[m.id] !== undefined}>
                  {m.label}
                </option>
              )}
            </For>
          </select>
        </label>
      </Show>
      <Show when={efforts().length > 0 && modelValue()}>
        <label class={shell.chip}>
          {efforts().find((l) => l.level === effortValue())?.label ?? (effortValue() || "Effort")}
          <select value={effortValue()} onChange={(e) => void pickEffort(e.currentTarget.value)}>
            <Show when={!efforts().some((l) => l.level === effortValue())}>
              <option value={effortValue()}>{effortValue() || "Effort"}</option>
            </Show>
            <For each={efforts()}>{(l) => <option value={l.level}>{l.label}</option>}</For>
          </select>
        </label>
      </Show>
      <For each={props.config.filter((o) => !o.disabled)}>
        {(option) =>
          option.kind === "select" ? (
            <label class={shell.chip}>
              {option.choices.find((c) => c.value === option.current)?.label ?? option.name}
              <select value={option.current} onChange={(e) => void setOption(option.id, e.currentTarget.value)}>
                <For each={option.choices}>{(c) => <option value={c.value}>{c.label}</option>}</For>
              </select>
            </label>
          ) : (
            <button
              type="button"
              class={shell.chip}
              aria-pressed={option.value}
              data-permissive={option.value}
              onClick={() => void setOption(option.id, !option.value)}
            >
              {option.name}
            </button>
          )
        }
      </For>
    </>
  );
}

function ChatMenu(props: {
  running: boolean;
  live: boolean;
  started: boolean;
  onStop: () => void;
  onRename: () => void;
  onClose: () => void;
  onChanges: () => void;
  onFork?: () => void;
  onSendToNew?: () => void;
  onCopy: () => void;
  onUnit?: () => void;
}) {
  const [open, setOpen] = createSignal(false);
  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <span class={shell.menuAnchor}>
      <button class={shell.more} aria-label="More" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <Icon icon={Ellipsis} size={20} strokeWidth={2} />
      </button>
      <Show when={open()}>
        <span class={shell.menuDim} onClick={() => setOpen(false)} />
        <span class={shell.menu} role="menu">
          <button role="menuitem" disabled={!props.running} onClick={run(props.onStop)}>
            Stop
          </button>
          <button role="menuitem" onClick={run(props.onRename)}>
            Rename
          </button>
          <Show when={props.live}>
            <button role="menuitem" onClick={run(props.onClose)}>
              Close session
            </button>
          </Show>
          <button role="menuitem" onClick={run(props.onChanges)}>
            Changes
          </button>
          <Show when={props.onSendToNew}>
            {(send) => (
              <button role="menuitem" onClick={run(send())}>
                Send to a new chat
              </button>
            )}
          </Show>
          <Show when={props.started && props.onFork}>
            {(fork) => (
              <button role="menuitem" onClick={run(fork())}>
                Fork this chat
              </button>
            )}
          </Show>
          <button role="menuitem" onClick={run(props.onCopy)}>
            Copy session id
          </button>
          <Show when={props.onUnit}>
            {(openUnit) => (
              <button role="menuitem" onClick={run(openUnit())}>
                Open worktree
              </button>
            )}
          </Show>
        </span>
      </Show>
    </span>
  );
}

function AttachMenu(props: { onFiles: (files: File[]) => void }) {
  const [open, setOpen] = createSignal(false);
  const pick = (accept: string, capture?: boolean) => () => {
    setOpen(false);
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = !capture;
    if (accept) input.accept = accept;
    if (capture) input.setAttribute("capture", "environment");
    input.onchange = () => props.onFiles([...(input.files ?? [])]);
    input.click();
  };
  return (
    <span class={shell.menuAnchor}>
      <button
        type="button"
        class={shell.chip}
        aria-label="Attach"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <Icon icon={Paperclip} size={14} strokeWidth={2.2} />
      </button>
      <Show when={open()}>
        <span class={shell.menuDim} onClick={() => setOpen(false)} />
        <span class={`${shell.menu} ${shell.menuUp}`} role="menu">
          <button type="button" role="menuitem" onClick={pick("image/*")}>
            Photo library
          </button>
          <button type="button" role="menuitem" onClick={pick("image/*", true)}>
            Camera
          </button>
          <button type="button" role="menuitem" onClick={pick("")}>
            File
          </button>
        </span>
      </Show>
    </span>
  );
}

export default function Chat(props: {
  client: RemoteClient;
  session: () => SessionRow;
  onBack: () => void;
  onUnit?: () => void;
  onChanged?: () => void;
  onOpen?: (row: SessionRow) => void;
  levers?: boolean;
}) {
  const id = props.session().id;
  const [view, setView] = createStore<{ chat: ChatState; error: string | null }>({
    chat: initialChat(id),
    error: null,
  });
  const [next, setNext] = createSignal<unknown>(null);
  const [paging, setPaging] = createSignal(false);
  const [pending, setPending] = createSignal<PendingRow[]>([]);
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const attached = createAttachments(props.client, (message) => setView("error", message));
  const [ask, setAsk] = createSignal<Ask | null>(null);
  const [chatAgents] = createResource(() =>
    props.client
      .request<{ agents: { id: string }[] }>("agents.list", {})
      .then((listed) => new Set(listed.agents.map((a) => a.id))),
  );
  // An ended chat resumes on the next message; an ended terminal session cannot.
  const resumable = () => props.session().live || chatAgents()?.has(props.session().agent ?? "") === true;
  const changed = () => props.onChanged?.();
  const rename = () =>
    setAsk({
      title: "Rename session",
      input: { label: "Name", value: props.session().name ?? props.session().title ?? "" },
      confirm: "Rename",
      run: (name) => props.client.request("session.rename", { id, name: name || null }).then(changed),
    });
  const [changes, setChanges] = createSignal(false);
  const [spent, { refetch: respend }] = createResource(
    () => props.client.generation() || undefined,
    () =>
      props.client
        .request<{ session: { costUsd: number | null } }>("session.call", { id, op: "usage_totals" })
        .catch(() => null),
  );
  onCleanup(
    props.client.subscribe(`session:${id}`, (data) => {
      if ((data as { kind?: string } | null)?.kind === "session.turn_ended") void respend();
    }),
  );
  const spawnAs = async (extra: Record<string, unknown>, forkOf?: string) => {
    const row = props.session();
    const started = await props.client.request<{ id: string; agent: string; folder: string }>("session.spawn", {
      folder: row.cwd,
      agent: row.agent,
      ...extra,
    });
    props.onOpen?.({
      id: started.id,
      agent: started.agent,
      cwd: started.folder,
      live: true,
      last_active: Math.floor(Date.now() / 1000),
      home: row.home,
      forkOf,
    });
  };
  const failed = (e: unknown) => setView("error", String(e instanceof Error ? e.message : e));
  const fork = () => void spawnAs({ fork: id }, id).catch(failed);
  const sendToNew = () => {
    const attach = attached.paths();
    if (!draft().trim() && attach.length === 0) return setView("error", "Type something first, or attach a file.");
    void spawnAs({ prompt: draft().trim() || undefined, attach: attach.length ? attach : undefined })
      .then(() => {
        setDraft("");
        attached.clear();
      })
      .catch(failed);
  };
  const askRevertHunk = (ref: HunkRef) =>
    new Promise<boolean>((resolve) => {
      let reverted = false;
      setAsk({
        title: `Revert this hunk of ${ref.path.split("/").pop()}?`,
        message: "Only these lines go back to what they were before the tool call.",
        confirm: "Revert",
        danger: true,
        run: async () => {
          await props.client.request("session.call", {
            id,
            op: "revert_tool_hunk",
            args: {
              tool_use_id: ref.toolUseId,
              path: ref.path,
              hunk_index: ref.hunkIndex,
              fingerprint: ref.fingerprint,
            },
          });
          reverted = true;
        },
        onClose: () => resolve(reverted),
      });
    });
  const slashes = () => {
    const typed = draft();
    if (!typed.startsWith("/") || /\s/.test(typed)) return [];
    const word = typed.slice(1).toLowerCase();
    return view.chat.slashCommands
      .filter((c) => [c.name, ...c.aliases].some((n) => n.toLowerCase().startsWith(word)))
      .slice(0, 8);
  };
  const gauge = () => {
    const used = view.chat.contextTokens;
    const window = view.chat.model
      ? contextWindowFor(view.chat.model, view.chat.contextWindows, view.chat.contextWindow)
      : view.chat.contextWindow;
    const pct = contextPercent(used, window);
    const parts = [];
    if (used !== null) {
      parts.push(
        window
          ? `Context ${fmtTokens(used)}/${fmtTokens(window)}${pct === null ? "" : ` (${pct}%)`}`
          : `Context ${fmtTokens(used)}`,
      );
    }
    const cost = spent()?.session.costUsd;
    if (cost != null) parts.push(fmtCost(cost));
    return parts.join(` ${DOT} `);
  };
  const close = () =>
    setAsk({
      title: "Close this session?",
      message: "It moves to this worktree's history. A message there resumes it.",
      confirm: "Close session",
      run: () => props.client.request("session.close", { id }).then(changed),
    });
  // An earlier page lands before the history but after nothing live, so the
  // two are kept apart and the chat is refolded from both.
  let history: ChatEvent[] = [];
  let live: ChatEvent[] = [];
  // Live events that arrive while history loads wait here, so nothing between
  // the history read and the subscription is lost.
  let parked: ChatEvent[] | null = null;
  let loads = 0;

  // Folded into a plain object and swapped in whole: one render per load.
  const refold = () => {
    const chat = initialChat(id);
    for (const ev of history) applyEvent(chat, ev);
    settleBackfill(chat);
    for (const ev of live) applyEvent(chat, ev);
    setView({ chat, error: null });
  };

  const onLive = (data: unknown) => {
    if ((data as { kind?: string } | null)?.kind === "chat.resync") {
      void load();
      return;
    }
    const ev = parseChatEvent(data);
    if (!ev) return;
    if (ev.type === "modeRefused") setView("error", ev.reason);
    if (parked) return void parked.push(ev);
    live.push(ev);
    setView(
      "chat",
      produce((chat) => applyEvent(chat, ev)),
    );
  };

  const page = (before: unknown) =>
    props.client.request<Page>(
      "session.history",
      {
        id,
        agent: props.session().agent,
        limit: HISTORY_TURNS,
        ...(before ? { before } : {}),
        ...(props.session().forkOf ? { from: props.session().forkOf } : {}),
      },
      HISTORY_REPLY_MS,
    );

  async function load() {
    const mine = ++loads;
    parked = [];
    try {
      const latest = await page(null);
      if (mine !== loads) return;
      history = parsed(latest.events);
      live = parked;
      parked = null;
      setNext(latest.next ?? null);
      refold();
    } catch (e) {
      if (mine !== loads) return;
      parked = null;
      setView("error", String(e instanceof Error ? e.message : e));
    }
  }

  async function earlier() {
    const before = next();
    if (!before || paging()) return;
    const mine = loads;
    setPaging(true);
    try {
      const older = await page(before);
      if (mine !== loads) return;
      history = [...parsed(older.events), ...history];
      setNext(older.next ?? null);
      refold();
    } catch (e) {
      if (mine === loads) setView("error", String(e instanceof Error ? e.message : e));
    } finally {
      setPaging(false);
    }
  }

  const refetchPending = () =>
    props.client
      .request<PendingRow[]>("session.pending", { id })
      .then(setPending)
      .catch(() => {});

  const send = async (method: "session.steer" | "session.interrupt") => {
    setSending(true);
    try {
      const attach = attached.paths();
      await props.client.request(
        method,
        method === "session.steer" ? { id, text: draft().trim(), attach: attach.length ? attach : undefined } : { id },
      );
      if (method === "session.steer") {
        setDraft("");
        attached.clear();
      }
    } catch (e) {
      setView("error", String(e instanceof Error ? e.message : e));
    } finally {
      setSending(false);
    }
  };

  onCleanup(props.client.subscribe(`chat:${id}`, onLive));
  onCleanup(
    props.client.subscribe(`session:${id}`, (data) => {
      if (PENDING_KINDS.has((data as { kind?: string } | null)?.kind ?? "")) void refetchPending();
    }),
  );
  onCleanup(
    props.client.subscribe("autopilot", (data) => {
      if (data && typeof data === "object" && "hold" in data) void refetchPending();
    }),
  );
  createEffect(
    on(props.client.generation, (n) => {
      if (n === 0) return;
      void load();
      void refetchPending();
    }),
  );

  const sendable = () => !sending() && !attached.uploading() && (draft().trim() !== "" || attached.files().length > 0);

  const phase = (): Phase => {
    const row = phaseOf(props.session());
    return row === "idle" && isRunning(view.chat) ? "working" : row;
  };
  const place = () => {
    const home = props.session().home;
    if (!home) return tail(props.session().cwd ?? "");
    return [home.project && tail(home.project), home.branch ?? tail(home.folder)].filter(Boolean).join(` ${NEXT} `);
  };

  return (
    <div class={shell.chat}>
      <header class={shell.chatTop}>
        <button class={shell.circle} aria-label="Back" onClick={() => props.onBack()}>
          <Icon icon={ChevronLeft} size={20} strokeWidth={2} />
        </button>
        <span class={shell.chatTitles}>
          <span class={shell.chatTitle}>{props.session().name || props.session().title || "New chat"}</span>
          <span class={shell.stateLine}>
            <PhaseMark phase={phase()} />
            {PHASE_LABEL[phase()]}
            <Show when={place()}>
              {" "}
              {DOT} {place()}
            </Show>
          </span>
        </span>
        <ChatMenu
          running={isRunning(view.chat)}
          live={props.session().live === true}
          onStop={() => void send("session.interrupt")}
          onRename={rename}
          onClose={close}
          started={view.chat.items.length > 0}
          onChanges={() => setChanges(true)}
          onFork={props.onOpen ? fork : undefined}
          onSendToNew={props.onOpen ? sendToNew : undefined}
          onCopy={() => void copy(id)}
          onUnit={props.onUnit}
        />
      </header>
      <Show when={view.error}>
        <p class={shell.banner}>{view.error}</p>
      </Show>
      <div class={styles.transcript}>
        <MessageList
          items={view.chat.items}
          streaming={isRunning(view.chat)}
          sessionId={id}
          cwd={props.session().cwd ?? ""}
          modelLabelFor={(turnId) => turnModel(view.chat, turnId)}
          agentTurn={(turnId) => view.chat.turns[turnId]?.agentInitiated === true}
          onSetMode={() => {}}
          onRevertHunk={askRevertHunk}
          onFetchEarlier={next() ? () => void earlier() : undefined}
        />
      </div>
      <Pending client={props.client} session={id} rows={pending()} onSettled={() => void refetchPending()} />
      <Show when={view.chat.plan.length > 0}>
        <div class={shell.plan}>
          <PlanCard items={view.chat.plan} stale={planStale(view.chat)} />
        </div>
      </Show>
      <Show when={gauge()}>
        <p class={shell.gauge}>{gauge()}</p>
      </Show>
      <Show when={ask()}>{(open) => <AskSheet ask={open()} onDone={() => setAsk(null)} />}</Show>
      <Show when={changes()}>
        <ChangesSheet client={props.client} id={id} onDone={() => setChanges(false)} />
      </Show>
      <Show when={resumable()}>
        <form
          class={shell.composer}
          onSubmit={(e) => {
            e.preventDefault();
            if (sendable()) void send("session.steer");
          }}
        >
          <Show when={attached.files().length}>
            <span class={shell.attached}>
              <For each={attached.files()}>
                {(file, i) => (
                  <span class={shell.chip} data-uploading={file.path === null}>
                    <span>{labels(attached.files())[i()]}</span>
                    <span class={shell.attachedName}>{file.path === null ? "Uploading" : file.name}</span>
                    <button type="button" aria-label={`Remove ${file.name}`} onClick={() => attached.remove(file.id)}>
                      <Icon icon={X} size={12} strokeWidth={2.4} />
                    </button>
                  </span>
                )}
              </For>
            </span>
          </Show>
          <Show when={slashes().length > 0}>
            <span class={shell.slashes}>
              <For each={slashes()}>
                {(command) => (
                  <button type="button" onClick={() => setDraft(`/${command.name} `)}>
                    <span>/{command.name}</span>
                    <span class={shell.slashHint}>{command.argumentHint ?? command.description}</span>
                  </button>
                )}
              </For>
            </span>
          </Show>
          <textarea
            class={shell.composerInput}
            rows={1}
            placeholder={
              isRunning(view.chat) ? "Steer the running turn" : props.session().live ? "Message" : "Message to resume"
            }
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
          />
          <span class={shell.composerRow}>
            <AttachMenu onFiles={(files) => void attached.add(files)} />
            <Show when={props.levers !== false && props.session().live}>
              <Levers
                client={props.client}
                id={id}
                agent={props.session().agent}
                refused={view.chat.refusedModes}
                effort={view.chat.effort}
                config={view.chat.configOptions}
                onError={(message) => setView("error", message)}
              />
            </Show>
            <button type="submit" class={shell.send} aria-label="Send" disabled={!sendable()}>
              <Icon icon={ArrowUp} size={17} strokeWidth={2.6} />
            </button>
          </span>
        </form>
      </Show>
    </div>
  );
}

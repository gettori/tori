import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { PanelWindow } from "../devtools";
import { PANEL_PORT } from "../pick";
import type { Chat, CommentOn, LogEntry, LogKind, PanelIn, PanelOut, PanelRequest, PanelState, Sent } from "../pick";
import { LOG_KEY } from "../tab";
import { rows, withDetail, type Detail, type DevToolsNetwork, type NetRequest, type Row } from "./rows";

const RETRIES = 5;
const RETRY_MS = 500;
const NEW_CHAT = "";
const KIND_LABEL: Record<LogKind, string> = {
  error: "console",
  warn: "warning",
  uncaught: "error",
  rejection: "rejection",
  request: "request",
  overlay: "build",
};

const tabId = chrome.devtools.inspectedWindow.tabId;

function ask<T>(message: PanelRequest): Promise<T> {
  return chrome.runtime.sendMessage(message);
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

const COMMENT_ON: CommentOn = "toriComment";
// Runs in the picker's world, where `$0` is the element selected in Elements; false means no picker answered.
const COMMENT_ON_SELECTED = `globalThis.${COMMENT_ON} ? globalThis.${COMMENT_ON}($0) : false`;

function commentInPage(): Promise<string | null> {
  return new Promise((resolve) =>
    chrome.devtools.inspectedWindow.eval<string | null | false>(
      COMMENT_ON_SELECTED,
      { useContentScriptContext: true },
      (...[result, failed]) => {
        if (failed || result === false) resolve("Tori could not reach the page. Reload it and try again.");
        else resolve(result);
      },
    ),
  );
}

export default function Panel() {
  const [state, setState] = createSignal<PanelState | null>(null);
  const [logOn, setLogOn] = createSignal(true);
  const [missing, setMissing] = createSignal(false);
  const [entries, setEntries] = createSignal<LogEntry[]>([]);
  const [overflow, setOverflow] = createSignal(0);
  const [network, setNetwork] = createSignal<DevToolsNetwork | null>(null);
  const [requests, setRequests] = createSignal<NetRequest[]>([]);
  const [sentRequests, setSentRequests] = createSignal(new Set<number>());
  const [leftOut, setLeftOut] = createSignal(new Set<string>());
  const [open, setOpen] = createSignal(new Set<string>());
  const [details, setDetails] = createSignal(new Map<number, Detail | null>());
  const [chats, setChats] = createSignal<Chat[]>([]);
  const [chosen, setChosen] = createSignal(NEW_CHAT);
  const [sending, setSending] = createSignal(false);
  const [said, setSaid] = createSignal("");
  const [error, setError] = createSignal("");
  const [refused, setRefused] = createSignal("");

  const shown = createMemo(() =>
    rows(
      entries(),
      requests().filter((r) => !sentRequests().has(r.id)),
    ),
  );
  const picked = () => shown().filter((row) => !leftOut().has(row.key));

  const toggle = (signal: () => Set<string>, set: (next: Set<string>) => void, key: string) => {
    const next = new Set(signal());
    if (!next.delete(key)) next.add(key);
    set(next);
  };

  const last = (row: Row) => row.requests[row.requests.length - 1];

  const expand = async (row: Row) => {
    toggle(open, setOpen, row.key);
    const request = last(row);
    if (!request || details().has(request.id)) return;
    const found = (await network()?.detail(request.id)) ?? null;
    setDetails(new Map(details()).set(request.id, found));
  };

  let port: chrome.runtime.Port | null = null;
  let retries = 0;
  // A reload restarts the page log's numbering, so a choice made on the last page must not carry over.
  let page = 0;
  const watch = () => port?.postMessage({ type: "watch", tabId } satisfies PanelIn);
  const connect = () => {
    const opened = chrome.runtime.connect({ name: PANEL_PORT });
    port = opened;
    opened.onMessage.addListener((message: PanelOut) => {
      if (message.type === "missing") {
        if (retries++ < RETRIES) setTimeout(watch, RETRY_MS);
        else setMissing(true);
        return;
      }
      retries = 0;
      setMissing(false);
      if (message.type !== "entries") {
        setOverflow(message.overflow);
        return;
      }
      if (message.page !== page) {
        page = message.page;
        setLeftOut(new Set<string>());
        setOpen(new Set<string>());
      }
      setEntries(message.entries);
    });
    // The worker sleeps and drops the port; a new one picks the page up again.
    opened.onDisconnect.addListener(() => {
      if (port !== opened) return;
      port = null;
      setTimeout(() => {
        connect();
        watch();
      }, RETRY_MS);
    });
  };

  const load = async () => {
    try {
      setLogOn((await chrome.storage.local.get(LOG_KEY))[LOG_KEY] !== false);
      const now = await ask<PanelState>({ type: "panel.state", tabId });
      setState(now);
      if (!now.worktree) return;
      const live = await ask<Chat[]>({ type: "panel.chats", tabId });
      setChats(live);
      if (!live.some((c) => c.id === chosen())) setChosen(live[0]?.id ?? NEW_CHAT);
    } catch (e) {
      setState({ worktree: null, title: e instanceof Error ? e.message : String(e) });
    }
  };

  const navigated = () => {
    retries = 0;
    setSaid("");
    setRefused("");
    void load();
    watch();
  };

  const send = async () => {
    const chat = chats().find((c) => c.id === chosen()) ?? null;
    const going = picked();
    const log = going.map((row) => {
      const request = last(row);
      return open().has(row.key) && request ? withDetail(row.entry, details().get(request.id) ?? null) : row.entry;
    });
    setSending(true);
    setError("");
    setSaid("");
    const outcome = await ask<Sent | null>({ type: "send.log", tabId, chat, log }).catch(
      (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }) as Sent,
    );
    setSending(false);
    if (!outcome) setError("Tori did not answer");
    else if ("error" in outcome) setError(outcome.error);
    else {
      const seqs = going.filter((row) => row.fromPageLog).map((row) => row.entry.seq);
      if (seqs.length) port?.postMessage({ type: "mark", seqs } satisfies PanelIn);
      const sent = new Set(sentRequests());
      for (const row of going) for (const request of row.requests) sent.add(request.id);
      setSentRequests(sent);
      setSaid(chat ? `Sent to ${outcome.title}` : "New chat open in Tori");
    }
  };

  const commentOnSelected = async () => {
    setRefused("");
    const why = await ask<string | null>({ type: "panel.inject", tabId }).catch((e: unknown) =>
      e instanceof Error ? e.message : String(e),
    );
    setRefused(why ?? (await commentInPage()) ?? "");
  };

  let unlisten = () => {};
  onCleanup(() => unlisten());

  onMount(() => {
    (window as PanelWindow).attach = (found) => {
      if (network() === found) return;
      unlisten();
      setNetwork(found);
      setRequests(found.list());
      unlisten = found.listen(() => setRequests(found.list()));
    };
    chrome.devtools.network.onNavigated.addListener(navigated);
    connect();
    watch();
    void load();
  });

  const counted = () => shown().reduce((sum, row) => sum + (row.entry.reportable ? row.entry.count : 0), 0);

  return (
    <main>
      <header>
        <span class="title">Tori</span>
        <span class="branch">{state()?.worktree ?? ""}</span>
        <Show when={counted()}>
          <span class="counted">{counted()} counted on the icon</span>
        </Show>
        <Show when={state()?.worktree}>
          <button type="button" class="more" onClick={() => void commentOnSelected()}>
            Comment on selected element
          </button>
        </Show>
      </header>
      <Show when={refused()}>
        <p class="empty" role="status">
          {refused()}
        </p>
      </Show>
      <Show when={state()} fallback={<p class="empty">Looking for the worktree...</p>}>
        {(now) => (
          <Show when={now().worktree} fallback={<p class="empty">{now().title}</p>}>
            <Show when={logOn()} fallback={<p class="empty">The page log is off in the Tori options.</p>}>
              <Show when={!missing()} fallback={<p class="empty">Reload the page to start the page log.</p>}>
                <Show when={shown().length} fallback={<p class="empty">Nothing on this page yet.</p>}>
                  <ul class="rows" aria-label="Page log entries">
                    <For each={shown()}>
                      {(row) => (
                        <li>
                          <div class="row">
                            <input
                              type="checkbox"
                              aria-label={oneLine(row.entry.text)}
                              checked={!leftOut().has(row.key)}
                              disabled={sending()}
                              onChange={() => toggle(leftOut, setLeftOut, row.key)}
                            />
                            <span
                              class={row.entry.reportable ? "kind counted" : "kind"}
                              title={row.entry.reportable ? "Counted on the Tori icon" : undefined}
                            >
                              {KIND_LABEL[row.entry.kind]}
                            </span>
                            <span class="text" title={row.entry.text}>
                              {oneLine(row.entry.text)}
                            </span>
                            <span class="times">{row.entry.count > 1 ? `x${row.entry.count}` : ""}</span>
                            <Show when={row.requests.length} fallback={<span />}>
                              <button
                                type="button"
                                class="more"
                                aria-expanded={open().has(row.key)}
                                onClick={() => void expand(row)}
                              >
                                {open().has(row.key) ? "Hide" : "Bodies"}
                              </button>
                            </Show>
                          </div>
                          <Show when={open().has(row.key) && last(row)}>
                            {(request) => (
                              <Show
                                when={details().get(request().id)}
                                fallback={
                                  <p class="detail">
                                    {details().has(request().id)
                                      ? "DevTools no longer holds this request."
                                      : "Loading..."}
                                  </p>
                                }
                              >
                                {(detail) => (
                                  <div class="detail">
                                    <p>{detail().url}</p>
                                    <h3>Request body</h3>
                                    <pre>{detail().request ?? "None"}</pre>
                                    <h3>Response body</h3>
                                    <pre>{detail().response ?? "None"}</pre>
                                    <p class="note">Sent with this entry while it is open.</p>
                                  </div>
                                )}
                              </Show>
                            )}
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                  <Show when={overflow()}>
                    <p class="lost">{overflow()} more not kept</p>
                  </Show>
                </Show>
              </Show>
            </Show>
          </Show>
        )}
      </Show>
      <Show when={state()?.worktree && logOn() && !missing()}>
        <footer>
          <label for="chat">Send to</label>
          <select id="chat" value={chosen()} disabled={sending()} onChange={(e) => setChosen(e.currentTarget.value)}>
            <For each={chats()}>{(chat) => <option value={chat.id}>{chat.title}</option>}</For>
            <option value={NEW_CHAT}>New chat in Tori</option>
          </select>
          <button type="button" class="primary" disabled={sending() || !picked().length} onClick={() => void send()}>
            {sending() ? "Sending..." : `Send ${picked().length}`}
          </button>
          <span class="said" role="status">
            {error() || said()}
          </span>
        </footer>
      </Show>
    </main>
  );
}

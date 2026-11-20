import { createSignal, Match, onMount, Switch } from "solid-js";
import type { SidebarWindow } from "../devtools";
import { ask, commentOnSelected, contextOfSelected, inject, tabId, UNREACHABLE } from "../inspected";
import type { Chat, ElementContext, PanelState } from "../pick";

type View =
  | { kind: "loading" }
  | { kind: "note"; text: string }
  | { kind: "context"; context: ElementContext; worktree: string; chat: string };

export default function Sidebar() {
  const [view, setView] = createSignal<View>({ kind: "loading" });
  const [refused, setRefused] = createSignal("");
  let shown = true;
  let injected = false;
  let chats: Chat[] | null = null;
  let latest = 0;

  const contextOf = async (): Promise<string | ElementContext> => {
    if (!injected) {
      const why = await inject();
      if (why) return why;
      injected = true;
    }
    const first = await contextOfSelected();
    if (first !== false) return first;
    // The picker this flag counted on is gone, as after the extension reloads.
    injected = false;
    const why = await inject();
    if (why) return why;
    injected = true;
    return (await contextOfSelected()) || UNREACHABLE;
  };

  const chatTitle = async (id: string | null): Promise<string> => {
    chats ??= await ask<Chat[] | null>({ type: "panel.chats", tabId })
      .then((found) => found ?? [])
      .catch(() => null);
    const list = chats ?? [];
    return (list.find((c) => c.id === id) ?? list[0])?.title ?? "New chat in Tori";
  };

  const read = async () => {
    const seq = ++latest;
    const stale = () => seq !== latest;
    setRefused("");
    const state = await ask<PanelState>({ type: "panel.state", tabId }).catch(() => null);
    if (stale()) return;
    if (!state?.worktree) {
      setView({ kind: "note", text: state?.title ?? UNREACHABLE });
      return;
    }
    const context = await contextOf();
    if (stale()) return;
    if (typeof context === "string") {
      setView({ kind: "note", text: context });
      return;
    }
    const chat = await chatTitle(context.chat);
    if (stale()) return;
    setView({ kind: "context", context, worktree: state.worktree, chat });
  };

  const note = () => {
    const now = view();
    return now.kind === "note" ? now.text : null;
  };
  const shownContext = () => {
    const now = view();
    return now.kind === "context" ? now : null;
  };

  const comment = async () => {
    setRefused("");
    const why = await commentOnSelected();
    if (why) setRefused(why);
    else void read();
  };

  onMount(() => {
    const win = window as SidebarWindow;
    win.shown = () => {
      shown = true;
      chats = null;
      void read();
    };
    win.hidden = () => {
      shown = false;
    };
    chrome.devtools.panels.elements.onSelectionChanged.addListener(() => {
      if (shown) void read();
    });
    chrome.devtools.network.onNavigated.addListener(() => {
      injected = false;
      chats = null;
      if (shown) void read();
    });
    void read();
  });

  return (
    <main>
      <Switch fallback={<p class="note">Looking for the worktree...</p>}>
        <Match when={note()}>{(text) => <p class="note">{text()}</p>}</Match>
        <Match when={shownContext()}>
          {(now) => (
            <>
              <dl>
                <dt>Element</dt>
                <dd class="code">{now().context.what}</dd>
                <dt>Components</dt>
                <dd class={now().context.chain.length ? "code" : "none"}>
                  {now().context.chain.join(" > ") || "No components found"}
                </dd>
                <dt>Source</dt>
                <dd class={now().context.source ? "code" : "none"}>{now().context.source ?? "No source line"}</dd>
                <dt>Worktree</dt>
                <dd>{now().worktree}</dd>
                <dt>Sends to</dt>
                <dd>{now().chat}</dd>
              </dl>
              <div class="act">
                <button
                  type="button"
                  class="primary"
                  disabled={!!now().context.commentBlocked}
                  onClick={() => void comment()}
                >
                  Comment
                </button>
                <span class="why" role="status">
                  {now().context.commentBlocked ?? refused()}
                </span>
              </div>
            </>
          )}
        </Match>
      </Switch>
    </main>
  );
}

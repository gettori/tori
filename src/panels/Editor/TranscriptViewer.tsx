import { createSignal, createEffect, on, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import styles from "./TranscriptViewer.module.css";

type TranscriptBlock = {
  kind: "text" | "thinking" | "tool_call" | "tool_result";
  text: string | null;
  tool_name: string | null;
  tool_input: unknown;
  is_error: boolean | null;
};
type TranscriptTurn = { role: "user" | "assistant" | "tool"; ts: number; blocks: TranscriptBlock[] };
type TranscriptPage = { turns: TranscriptTurn[]; next_cursor: number | null };

function fmtTime(epochSecs: number): string {
  return epochSecs ? new Date(epochSecs * 1000).toLocaleString() : "";
}

/** Read-only transcript viewer: the turn list tail-first (newest at top), tool
 *  calls/results collapsed to a one-line summary. Live-refreshes on
 *  sessions://changed while at the tail (no older page loaded yet); once
 *  "Load older" is used the view is a frozen historical scroll. */
export default function TranscriptViewer(props: { sessionPath: string; agent: "claude" | "pi"; class?: string }) {
  const [turns, setTurns] = createSignal<TranscriptTurn[]>([]);
  const [nextCursor, setNextCursor] = createSignal<number | null>(null);
  const [atTail, setAtTail] = createSignal(true);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [openBlocks, setOpenBlocks] = createSignal<Set<string>>(new Set());
  // Guards against an out-of-order response: switching between two transcript
  // tabs before a slower fetch resolves must not overwrite the newly-active
  // tab's turns with the previous tab's data (same race class as SessionPanel).
  let requestFor: string | null = null;
  const requestKey = () => `${props.sessionPath}:${props.agent}`;

  async function loadLatest() {
    const key = requestKey();
    requestFor = key;
    const page = await invoke<TranscriptPage>("session_transcript", {
      path: props.sessionPath,
      agent: props.agent,
      cursor: null,
    }).catch(() => null);
    if (!page || requestFor !== key) return;
    setTurns(page.turns);
    setNextCursor(page.next_cursor);
    setAtTail(true);
    setOpenBlocks(new Set<string>());
  }

  async function loadOlder() {
    const cursor = nextCursor();
    if (cursor == null || loadingMore()) return;
    const key = requestKey();
    setLoadingMore(true);
    setAtTail(false);
    try {
      const page = await invoke<TranscriptPage>("session_transcript", {
        path: props.sessionPath,
        agent: props.agent,
        cursor,
      }).catch(() => null);
      if (page && requestFor === key) {
        setTurns((t) => [...t, ...page.turns]);
        setNextCursor(page.next_cursor);
      }
    } finally {
      setLoadingMore(false);
    }
  }

  createEffect(
    on(
      () => [props.sessionPath, props.agent] as const,
      () => void loadLatest(),
    ),
  );

  let unlisten: UnlistenFn | undefined;
  onMount(async () => {
    unlisten = await listen("sessions://changed", () => {
      if (atTail()) void loadLatest();
    });
  });
  onCleanup(() => unlisten?.());

  function blockKey(ti: number, bi: number) {
    return `${ti}:${bi}`;
  }
  function toggleBlock(key: string) {
    const next = new Set(openBlocks());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setOpenBlocks(next);
  }

  return (
    <div class={`${styles.viewer} ${props.class ?? ""}`}>
      <For each={turns()}>
        {(turn, ti) => (
          <div class={`${styles.turn} ${styles[turn.role] ?? ""}`}>
            <div class={styles.turnHeader}>
              <span class={styles.turnRole}>{turn.role}</span>
              <span class={styles.turnTime}>{fmtTime(turn.ts)}</span>
            </div>
            <For each={turn.blocks}>
              {(block, bi) => {
                const key = blockKey(ti(), bi());
                const collapsible = block.kind === "tool_call" || block.kind === "tool_result";
                return (
                  <div class={`${styles.block} ${styles[block.kind] ?? ""}`}>
                    <Show when={collapsible} fallback={<div class={styles.blockText}>{block.text}</div>}>
                      <div class={styles.blockSummary} onClick={() => toggleBlock(key)}>
                        <span class={styles.chevron} classList={{ [styles.open]: openBlocks().has(key) }}>
                          ▸
                        </span>
                        <span class={styles.toolName}>{block.tool_name ?? block.kind}</span>
                        <Show when={block.is_error}>
                          <span class={styles.errorBadge}>error</span>
                        </Show>
                      </div>
                      <Show when={openBlocks().has(key)}>
                        <pre class={styles.blockDetail}>
                          {block.kind === "tool_call" ? JSON.stringify(block.tool_input, null, 2) : block.text}
                        </pre>
                      </Show>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        )}
      </For>
      <Show when={nextCursor() != null}>
        <button class={styles.loadOlder} onClick={loadOlder} disabled={loadingMore()}>
          {loadingMore() ? "Loading…" : "Load older"}
        </button>
      </Show>
      <Show when={!turns().length}>
        <div class="tree-empty">No transcript turns</div>
      </Show>
    </div>
  );
}

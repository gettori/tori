import { For, Show, createResource, createSignal } from "solid-js";
import AskSheet, { type Ask } from "./AskSheet";
import type { RemoteClient } from "./remote";
import styles from "./shell.module.css";

type Checkpoint = { turn: number; kind: string; file_count: number };
type Diff = { files: unknown[]; diff: string };
type Shown = { title: string; turn: number; to?: number };

function DiffText(props: { text: string }) {
  const sign = (line: string) =>
    line.startsWith("+") && !line.startsWith("+++")
      ? "add"
      : line.startsWith("-") && !line.startsWith("---")
        ? "del"
        : "";
  return (
    <pre class={styles.diff}>
      <For each={props.text.split("\n")}>{(line) => <span data-line={sign(line)}>{`${line}\n`}</span>}</For>
    </pre>
  );
}

export default function ChangesSheet(props: { client: RemoteClient; id: string; onDone: () => void }) {
  const [list] = createResource(() =>
    props.client
      .request<Checkpoint[]>("checkpoints.list", { id: props.id })
      .then((rows) => rows.filter((row) => row.kind === "")),
  );
  const [shown, setShown] = createSignal<Shown | null>(null);
  const [diff] = createResource(shown, (s) =>
    props.client.request<Diff>("checkpoint.diff", { id: props.id, turn: s.turn, to: s.to }),
  );
  const [ask, setAsk] = createSignal<Ask | null>(null);
  const rewind = (turn: number) =>
    setAsk({
      title: `Rewind the files to before turn ${turn}?`,
      message:
        "What this session wrote in that turn and every turn after it is undone in the worktree. Tori keeps a backstop first, so the Mac's timeline can bring it back. The conversation stays as it is, so the agent still remembers writing it.",
      confirm: "Rewind",
      danger: true,
      run: () => props.client.request("checkpoint.revert", { id: props.id, turn }).then(() => setShown(null)),
    });
  const last = () => {
    const rows = list() ?? [];
    return rows[rows.length - 1]?.turn;
  };
  return (
    <>
      <div class={styles.dim} onClick={() => props.onDone()} />
      <section class={styles.sheet} role="dialog" aria-label="Changes">
        <span class={styles.grabber} />
        <header class={styles.sheetHead}>
          <span class={styles.sheetTitle}>{shown()?.title ?? "Changes"}</span>
          <button class={styles.done} onClick={() => (shown() ? setShown(null) : props.onDone())}>
            {shown() ? "Back" : "Done"}
          </button>
        </header>
        <div class={styles.sheetBody}>
          <Show when={list.error || diff.error}>
            <p class={styles.banner}>{String(list.error ?? diff.error)}</p>
          </Show>
          <Show
            when={shown()}
            fallback={
              <ul class={styles.group}>
                <Show when={last()}>
                  {(to) => (
                    <li>
                      <button
                        class={`${styles.item} ${styles.setting}`}
                        onClick={() => setShown({ title: "All changes", turn: 1, to: to() })}
                      >
                        <span class={styles.text}>All changes</span>
                      </button>
                    </li>
                  )}
                </Show>
                <For
                  each={list() ?? []}
                  fallback={<li class={styles.empty}>{list.loading ? "Loading" : "No changes recorded"}</li>}
                >
                  {(row) => (
                    <li>
                      <div class={`${styles.item} ${styles.setting}`}>
                        <button
                          class={styles.text}
                          onClick={() => setShown({ title: `Turn ${row.turn}`, turn: row.turn })}
                        >
                          Turn {row.turn}
                          <span class={styles.meta}>
                            {" "}
                            {row.file_count} {row.file_count === 1 ? "file" : "files"}
                          </span>
                        </button>
                        <button class={styles.value} onClick={() => rewind(row.turn)}>
                          Rewind
                        </button>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            }
          >
            <Show when={diff()} fallback={<p class={styles.empty}>Loading</p>}>
              {(d) => (
                <Show when={d().diff} fallback={<p class={styles.empty}>No file changes</p>}>
                  <DiffText text={d().diff} />
                </Show>
              )}
            </Show>
          </Show>
        </div>
      </section>
      <Show when={ask()}>{(a) => <AskSheet ask={a()} onDone={() => setAsk(null)} />}</Show>
    </>
  );
}

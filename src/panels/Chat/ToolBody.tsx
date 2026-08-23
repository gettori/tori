import { For, Show, Switch, Match, createMemo, createSignal, type JSX } from "solid-js";
import { cappedHtml } from "./highlight";
import { BODY_ROWS, hitRows, pathRows, prettyJson, readLines, stripAnsi } from "./toolOutput";
import { toolDigest, toolPaths, type ToolRenderer } from "./toolRenderers";
import type { ToolItem } from "./chatStore";
import styles from "./Chat.module.css";

// The expanded halves of a tool card, one per renderer.
//
// A separate component rather than more branches inside the card, for a reason
// that is not tidiness: every memo in here belongs to a body that only exists
// while the card is open, so a transcript of sixty collapsed calls holds sixty
// cards and zero highlighting passes.

/** A block that paints plain now and colorizes in place once shiki and the
 *  grammar are in, or stays plain forever when it is too big to be worth it. */
function Highlighted(props: { code: string; lang: string }) {
  const html = createMemo(() => cappedHtml(props.code, props.lang));
  return (
    <Show when={html()} fallback={<code>{props.code}</code>}>
      {(h) => <code innerHTML={h()} />}
    </Show>
  );
}

/** A list body, showing the first `BODY_ROWS` entries and offering the rest.
 *  A `Grep` answers with thousands and a transcript is not a results pane. */
function Rows<T>(props: { rows: T[]; children: (row: T) => JSX.Element }) {
  const [all, setAll] = createSignal(false);
  // Memoized because `rows` is a props getter over a parse of the whole output,
  // and it is read more than once per pass. Without this a 5000-hit body
  // re-parses its text on every render rather than on every change to it.
  const rows = createMemo(() => props.rows);
  const shown = () => (all() ? rows() : rows().slice(0, BODY_ROWS));
  return (
    <>
      <div class={`${styles.toolPre} ${styles.toolRows}`}>
        <For each={shown()}>{props.children}</For>
      </div>
      {/* "rows", not "output": the other control on this card offers the rest
          of the text, and these two must not read as the same offer. */}
      <Show when={!all() && rows().length > BODY_ROWS}>
        <button type="button" class={styles.toolMore} onClick={() => setAll(true)}>
          Show all {rows().length} rows
        </button>
      </Show>
    </>
  );
}

/**
 * What the call was asked to do.
 *
 * A shell command is read as a command, not as JSON with a `command` key in it.
 * The prompt is not part of the source, so the grammar never sees it.
 */
export function ToolInput(props: { card: ToolItem; renderer: ToolRenderer }) {
  const command = () => toolDigest(props.card);
  const json = () => {
    const input = props.card.input;
    if (typeof input === "string") return input;
    try {
      return JSON.stringify(input, null, 2) ?? "";
    } catch {
      return String(input);
    }
  };
  return (
    <Switch>
      <Match when={props.renderer === "execute" && command()}>
        {(cmd) => (
          <pre class={`${styles.toolPre} ${styles.toolCommand}`}>
            <span class={styles.toolPrompt}>$ </span>
            <Highlighted code={cmd()} lang="shell" />
          </pre>
        )}
      </Match>
      <Match when={props.renderer !== "execute" || !command()}>
        <pre class={styles.toolPre}>
          <Highlighted code={json()} lang="json" />
        </pre>
      </Match>
    </Switch>
  );
}

/**
 * What the call answered with.
 *
 * Every body here is built from the output text and the summary, never from the
 * tool's name. A read gets its file's own line numbers back as click targets, a
 * search and a path list get one clickable row per entry, and a command gets
 * its terminal escapes stripped, since there is no terminal here to obey them.
 */
export function ToolOutput(props: {
  card: ToolItem;
  renderer: ToolRenderer;
  text: string;
  onOpen: (path: string, line?: number) => void;
}) {
  // ACP answers an execute call with its whole `rawOutput` object, so this is
  // the difference between a readable body and a JSON blob on one line.
  const json = createMemo(() => (props.renderer === "execute" ? prettyJson(props.text) : null));
  const from = () => {
    const summary = props.card.summary;
    return summary?.type === "read" ? summary.from : 1;
  };
  // The path a read's lines belong to. A read names exactly one file, so the
  // first path the card knows is the one to open, whether the agent published
  // it as a location or it is sitting in the call's own arguments.
  const readPath = () => toolPaths(props.card)[0] ?? null;

  return (
    <Switch fallback={<pre class={`${styles.toolPre} ${styles.toolOutput}`}>{props.text}</pre>}>
      <Match when={json()}>
        {(pretty) => (
          <pre class={styles.toolPre}>
            <Highlighted code={pretty()} lang="json" />
          </pre>
        )}
      </Match>
      <Match when={props.renderer === "execute"}>
        <pre class={`${styles.toolPre} ${styles.toolOutput}`}>{stripAnsi(props.text)}</pre>
      </Match>
      <Match when={props.renderer === "read"}>
        <Rows rows={readLines(props.text, from())}>
          {(row) => (
            <div class={styles.toolLine}>
              <Show when={readPath()} fallback={<span class={styles.toolGutter}>{row.line}</span>}>
                {(path) => (
                  <button
                    type="button"
                    class={styles.toolGutter}
                    aria-label={`Open at line ${row.line}`}
                    onClick={() => props.onOpen(path(), row.line)}
                  >
                    {row.line}
                  </button>
                )}
              </Show>
              <span class={styles.toolLineText}>{row.text}</span>
            </div>
          )}
        </Rows>
      </Match>
      <Match when={props.renderer === "search"}>
        <Rows rows={hitRows(props.text)}>
          {(row) => (
            <div class={styles.toolLine}>
              <Show when={row.path}>
                {(path) => (
                  <button
                    type="button"
                    class={styles.toolHit}
                    aria-label={`Open ${path()} at line ${row.line}`}
                    onClick={() => props.onOpen(path(), row.line ?? undefined)}
                  >
                    {path()}:{row.line}
                  </button>
                )}
              </Show>
              <span class={styles.toolLineText}>{row.text}</span>
            </div>
          )}
        </Rows>
      </Match>
      <Match when={props.renderer === "paths"}>
        <Rows rows={pathRows(props.text)}>
          {(path) => (
            <button type="button" class={styles.toolHit} onClick={() => props.onOpen(path)}>
              {path}
            </button>
          )}
        </Rows>
      </Match>
    </Switch>
  );
}

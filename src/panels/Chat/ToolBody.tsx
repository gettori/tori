import { For, Show, Switch, Match, createMemo, createSignal, type JSX } from "solid-js";
import { createHighlight, langOfPath } from "./highlight";
import { BODY_ROWS, hitRows, pathRows, prettyJson, readLines, stripAnsi } from "./toolOutput";
import { toolDiffBody, type DiffHunk, type DiffRow } from "./toolDiff";
import { toolDigest, toolPaths, type ToolRenderer } from "./toolRenderers";
import type { ToolItem } from "./chatStore";
import { traceWork } from "../../utils/perfTrace";
import OverlayScroll from "../../components/Scrollbar/OverlayScroll";
import styles from "./Chat.module.css";

// The expanded halves of a tool card, one per renderer.
//
// A separate component rather than more branches inside the card, for a reason
// that is not tidiness: every memo in here belongs to a body that only exists
// while the card is open, so a transcript of sixty collapsed calls holds sixty
// cards and zero highlighting passes.

/** Opens a path in the editor, at a line where one is known. The card owns it,
 *  because the workspace check and the event belong to the card. */
type OpenPath = (path: string, line?: number) => void;

type Highlight = ReturnType<typeof createHighlight>;

/** A block that paints plain now and colorizes in place once shiki and the
 *  grammar are in, or stays plain forever when it is too big to be worth it. */
function Highlighted(props: { code: string; lang: string }) {
  const hl = createHighlight();
  const html = createMemo(() => hl.html(props.code, props.lang));
  return (
    <Show when={html()} fallback={<code>{props.code}</code>}>
      {(h) => <code innerHTML={h()} />}
    </Show>
  );
}

/** One line inside a row body: coloured where the grammar is in, plain
 *  otherwise, and never both. */
function Line(props: { html: string | null; text: string }) {
  return (
    <Show when={props.html} fallback={<span class={styles.toolLineText}>{props.text}</span>}>
      {(h) => <span class={styles.toolLineText} innerHTML={h()} />}
    </Show>
  );
}

/** A list body, showing the first `BODY_ROWS` entries and offering the rest.
 *  A `Grep` answers with thousands and a transcript is not a results pane. */
function Rows<T>(props: { rows: T[]; class?: string; children: (row: T, index: () => number) => JSX.Element }) {
  const [all, setAll] = createSignal(false);
  // Memoized because `rows` is a props getter over a parse of the whole output,
  // and it is read more than once per pass. Without this a 5000-hit body
  // re-parses its text on every render rather than on every change to it.
  const rows = createMemo(() => props.rows);
  const shown = () => (all() ? rows() : rows().slice(0, BODY_ROWS));
  return (
    <>
      <OverlayScroll class={`${styles.toolPre} ${styles.toolRows} ${props.class ?? ""}`}>
        <For each={shown()}>{props.children}</For>
      </OverlayScroll>
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
 * A file's content, numbered, with each number a way into the editor.
 *
 * Highlighted by the file's own language, which is the thing on a read card
 * worth colouring: the arguments above it are two keys and a path.
 */
function CodeLines(props: { text: string; from: number; path: string | null; onOpen: OpenPath }) {
  const rows = createMemo(() => readLines(props.text, props.from));
  const hl = createHighlight();
  // One pass over the whole body rather than one per line, so a comment or a
  // string spanning several lines is coloured as the one thing it is.
  const painted = createMemo(() =>
    hl.lines(
      rows()
        .map((r) => r.text)
        .join("\n"),
      props.path ? langOfPath(props.path) : "",
    ),
  );
  return (
    <Rows rows={rows()}>
      {(row, i) => (
        <div class={styles.toolLine}>
          <Show when={props.path} fallback={<span class={styles.toolGutter}>{row.line}</span>}>
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
          <Line html={painted()?.[i()] ?? null} text={row.text} />
        </div>
      )}
    </Rows>
  );
}

/**
 * A hunk's lines, painted.
 *
 * Each side is highlighted as its own text rather than the two interleaved: the
 * removed lines and the added lines are each a coherent fragment, and the
 * mixture of them is neither and tokenizes as neither.
 */
function paint(rows: DiffRow[], lang: string, hl: Highlight, hunk: number): (string | null)[] {
  const text = (drop: DiffRow["kind"]) =>
    rows
      .filter((r) => r.kind !== drop)
      .map((r) => r.text)
      .join("\n");
  const before = hl.lines(text("add"), lang, `${hunk}:old`);
  const after = hl.lines(text("del"), lang, `${hunk}:new`);
  // Walked rather than indexed: a row's place in its own side is not its place
  // in the hunk, and a changed row exists on only one of the two.
  let oldAt = 0;
  let newAt = 0;
  return rows.map((row) => {
    if (row.kind === "add") return after?.[newAt++] ?? null;
    if (row.kind === "del") return before?.[oldAt++] ?? null;
    return after?.[newAt++] ?? before?.[oldAt++] ?? null;
  });
}

/** One line of a rendered diff: a hunk's `@@` separator, or a row of code. */
type DiffLine = { header: string; hunk: number } | { row: DiffRow; html: string | null; hunk: number };

/**
 * A whole diff, in one scrolling block.
 *
 * One block and not one per hunk: a hunk is a place in a file, not a document
 * of its own, and giving each its own frame and its own scrollbar made reading
 * a four-hunk edit an exercise in scrolling four times. The `@@` line separates
 * them from inside instead.
 */
export function DiffView(props: {
  hunks: DiffHunk[];
  lang: string;
  path: string | null;
  onOpen: OpenPath;
  action?: (hunk: DiffHunk, index: number) => JSX.Element;
}) {
  const hl = createHighlight();
  const lines = createMemo(() => {
    const out: DiffLine[] = [];
    props.hunks.forEach((hunk, at) => {
      if (hunk.header) out.push({ header: hunk.header, hunk: at });
      const painted = paint(hunk.rows, props.lang, hl, at);
      hunk.rows.forEach((row, i) => out.push({ row, html: painted[i], hunk: at }));
    });
    return out;
  });
  const opensAt = (at: number) => props.hunks[at]?.rows.find((r) => r.newLine !== null)?.newLine ?? undefined;

  return (
    <Rows rows={lines()} class={styles.toolDiffRows}>
      {(line) => (
        <Show when={"header" in line ? line : null} fallback={<CodeRow line={line as Extract<DiffLine, { row: DiffRow }>} />}>
          {(head) => (
            <div class={styles.diffHunkRow}>
              <Show
                when={props.path}
                fallback={<span class={styles.diffHunkHeader}>{head().header}</span>}
              >
                {(path) => (
                  <button
                    type="button"
                    class={styles.diffHunkHeader}
                    aria-label={`Open at line ${opensAt(head().hunk) ?? 1}`}
                    onClick={() => props.onOpen(path(), opensAt(head().hunk))}
                  >
                    {head().header}
                  </button>
                )}
              </Show>
              {props.action?.(props.hunks[head().hunk], head().hunk)}
            </div>
          )}
        </Show>
      )}
    </Rows>
  );
}

function CodeRow(props: { line: Extract<DiffLine, { row: DiffRow }> }) {
  const row = () => props.line.row;
  return (
    <div
      class={styles.diffRow}
      classList={{
        [styles.diffRowAdd]: row().kind === "add",
        [styles.diffRowDel]: row().kind === "del",
      }}
    >
      <span class={styles.diffNum}>{row().oldLine ?? ""}</span>
      <span class={styles.diffNum}>{row().newLine ?? ""}</span>
      <span class={styles.diffMark}>{row().kind === "add" ? "+" : row().kind === "del" ? "-" : " "}</span>
      <Line html={props.line.html} text={row().text} />
    </div>
  );
}

/**
 * The diff this call made, from the transport's own patch where there is one
 * and from the call's own arguments where there is not.
 *
 * Null when the call wrote nothing. Unlike the working-tree diff the card can
 * fetch, this one survives a reload: nothing captures a before-state for a
 * session this process never watched run, which is why a reopened conversation
 * used to show its edits as raw JSON and nothing else.
 */
export function ToolDiff(props: { cards: ToolItem[]; onOpen: OpenPath }) {
  // One diff for the whole card, even when several calls folded onto it: three
  // writes to one file are three parts of one change, and giving each its own
  // block is the thing folding them was supposed to stop.
  const body = createMemo(() => {
    const bodies = traceWork("tool-diff", () =>
      props.cards.map((c) => toolDiffBody(c.patch, c.input)).filter((b) => b !== null),
    );
    if (!bodies.length) return null;
    return { hunks: bodies.flatMap((b) => b.hunks), computed: bodies.some((b) => b.computed) };
  });
  const path = () => toolPaths(props.cards[0])[0] ?? null;
  return (
    <Show when={body()}>
      {(diff) => (
        <>
          <DiffView
            hunks={diff().hunks}
            lang={path() ? langOfPath(path()!) : ""}
            // A computed diff has no line numbers to open at, so its header is
            // not a link to a place it cannot name.
            path={diff().computed ? null : path()}
            onOpen={props.onOpen}
          />
          <Show when={diff().computed}>
            <span class={styles.toolNote}>Drawn from the call's arguments, which carry no line numbers.</span>
          </Show>
        </>
      )}
    </Show>
  );
}

function multiline(v: unknown): v is string {
  return typeof v === "string" && v.includes("\n");
}

/** The grammar a block-shaped argument gets: what the call itself said, else
 *  what the file it names implies. */
function argLang(rec: Record<string, unknown>): string {
  for (const key of ["language", "lang"]) {
    const v = rec[key];
    if (typeof v === "string" && v) return v;
  }
  const path = rec.file_path ?? rec.path ?? rec.notebook_path;
  return typeof path === "string" ? langOfPath(path) : "";
}

/**
 * What the call was asked to do.
 *
 * A shell command is read as a command, not as JSON with a `command` key in it,
 * and the same holds for any other argument that turns out to be a program: an
 * MCP tool taking a `code` string is the everyday case, and `JSON.stringify`
 * puts that on one line with `\n` in it, which nobody can read.
 */
export function ToolInput(props: { card: ToolItem; renderer: ToolRenderer; onOpen: OpenPath }) {
  const command = () => toolDigest(props.card);
  const rec = () => {
    const input = props.card.input;
    return input && typeof input === "object" ? (input as Record<string, unknown>) : null;
  };
  const blocks = createMemo(() => Object.entries(rec() ?? {}).filter(([, v]) => multiline(v)) as [string, string][]);
  const rest = createMemo(() => {
    const r = rec();
    if (!r) return props.card.input;
    return Object.fromEntries(Object.entries(r).filter(([, v]) => !multiline(v)));
  });
  const restText = createMemo(() => {
    const value = rest();
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value, null, 2) ?? "";
    } catch {
      return String(value);
    }
  });

  return (
    <Switch>
      {/* A write's arguments *are* its diff, and reading `old_string` beside
          `new_string` as two escaped JSON strings is the thing this replaces. */}
      <Match when={props.renderer === "edit" && toolDiffBody(props.card.patch, props.card.input)}>
        <ToolDiff cards={[props.card]} onOpen={props.onOpen} />
      </Match>
      {/* A read's arguments are the file and maybe a range: the path chip above
          names the first and the summary on the row reports the second, so the
          block would be a third copy of what is already on screen. */}
      <Match when={props.renderer === "read" && !blocks().length}>{null}</Match>
      <Match when={props.renderer === "execute" && command()}>
        {(cmd) => (
          <pre class={`${styles.toolPre} ${styles.toolCommand}`}>
            <span class={styles.toolPrompt}>$ </span>
            <Highlighted code={cmd()} lang="shell" />
          </pre>
        )}
      </Match>
      <Match when={blocks().length}>
        <For each={blocks()}>
          {([key, value]) => (
            <>
              <span class={styles.toolArgName}>{key}</span>
              <pre class={styles.toolPre}>
                <Highlighted code={value} lang={argLang(rec() ?? {})} />
              </pre>
            </>
          )}
        </For>
        {/* Whatever was left over, which is often nothing worth a block of its
            own once the programs have been lifted out. */}
        <Show when={restText() !== "{}"}>
          <pre class={styles.toolPre}>
            <Highlighted code={restText()} lang="json" />
          </pre>
        </Show>
      </Match>
      <Match when={!blocks().length}>
        <pre class={styles.toolPre}>
          <Highlighted code={restText()} lang="json" />
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
  onOpen: OpenPath;
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
        <CodeLines text={props.text} from={from()} path={readPath()} onOpen={props.onOpen} />
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

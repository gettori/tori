import { Match, Show, Switch, createMemo, createSignal, onCleanup } from "solid-js";
import { Check, Code, Copy, Eye } from "lucide-solid";
import { sanitizeHtml } from "../../utils/sanitizeHtml";
import { copyText } from "../../utils/clipboard";
import { cappedHtml } from "./highlight";
import { PROSE } from "./chatMarked";
import Icon from "../../components/Icon/Icon";
import Diagram from "../../components/Diagram/Diagram";
import styles from "./Chat.module.css";

// Front matter is metadata about the document, not the document: rendered,
// its fences degenerate into an hr through the corner controls and a stray
// heading, so the preview drops it. The source view still shows it verbatim.
function stripFrontMatter(text: string): string {
  const m = /^---\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/**
 * One fenced code block in the transcript: the language label in the corner
 * says what it is, copy takes the raw text, and an `md` or `mermaid` fence can
 * flip between its source and its rendered form. Paints plain immediately and
 * colorizes in place once the lazy highlighter and the grammar are in.
 */
export default function CodeBlock(props: { lang: string; code: string }) {
  const [copied, setCopied] = createSignal(false);
  const [flipped, setFlipped] = createSignal(false);
  const isMarkdown = () => /^(md|mdx|mkd|markdown)$/i.test(props.lang);
  const isMermaid = () => /^mermaid$/i.test(props.lang);
  // A diagram opens drawn and a markdown fence opens as source, because that is
  // what each one is for. One flag, read against whichever face is the default.
  const rendered = () => flipped() !== isMermaid();
  const toggleLabel = () => {
    if (isMermaid()) return rendered() ? "Show diagram source" : "Draw diagram";
    return rendered() ? "Show markdown source" : "Preview markdown";
  };
  const html = createMemo(() => cappedHtml(props.code, props.lang));

  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const copy = async () => {
    if (!(await copyText(props.code))) return;
    setCopied(true);
    clearTimeout(timer);
    timer = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div class={styles.codeBlock}>
      {/* Label last, hugging the corner: the buttons before it are invisible
          until hover, and a label sitting left of two hidden buttons reads as
          floating mid-air rather than as the block's corner annotation. */}
      <div class={styles.codeControls}>
        <Show when={isMarkdown() || isMermaid()}>
          <button
            type="button"
            class={styles.codeBtn}
            aria-label={toggleLabel()}
            aria-pressed={rendered()}
            onClick={() => setFlipped(!flipped())}
          >
            <Icon icon={rendered() ? Code : Eye} size={13} aria-hidden="true" />
          </button>
        </Show>
        <button type="button" class={styles.codeBtn} aria-label="Copy code" onClick={copy}>
          <Icon icon={copied() ? Check : Copy} size={13} aria-hidden="true" />
        </button>
        <Show when={props.lang}>
          <span class={styles.codeLang}>{props.lang}</span>
        </Show>
      </div>
      <Switch
        fallback={
          <div
            class={styles.codePreview}
            innerHTML={sanitizeHtml(PROSE.parse(stripFrontMatter(props.code)) as string)}
          />
        }
      >
        <Match when={!rendered()}>
          <pre>
            <Show when={html()} fallback={<code>{props.code}</code>}>
              {(h) => <code innerHTML={h()} />}
            </Show>
          </pre>
        </Match>
        <Match when={isMermaid()}>
          <Diagram code={props.code} />
        </Match>
      </Switch>
    </div>
  );
}

import { Show, createMemo, createSignal, onCleanup } from "solid-js";
import { Check, Code, Copy, Eye } from "lucide-solid";
import { marked } from "marked";
import { sanitizeHtml } from "../../utils/sanitizeHtml";
import { copyText } from "../../utils/clipboard";
import { highlightedHtml } from "./highlight";
import Icon from "../../components/Icon/Icon";
import styles from "./Chat.module.css";

// Above this a block is pasted output, not code being read, and a TextMate
// pass over it would be the one thing on the streaming path worth feeling.
const HIGHLIGHT_MAX = 100_000;

// Front matter is metadata about the document, not the document: rendered,
// its fences degenerate into an hr through the corner controls and a stray
// heading, so the preview drops it. The source view still shows it verbatim.
function stripFrontMatter(text: string): string {
  const m = /^---\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/**
 * One fenced code block in the transcript: the language label in the corner
 * says what it is, copy takes the raw text, and an `md` fence can flip to its
 * rendered form. Paints plain immediately and colorizes in place once the
 * lazy highlighter and the grammar are in.
 */
export default function CodeBlock(props: { lang: string; code: string }) {
  const [copied, setCopied] = createSignal(false);
  const [preview, setPreview] = createSignal(false);
  const isMarkdown = () => /^(md|mdx|mkd|markdown)$/i.test(props.lang);
  const html = createMemo(() => (props.code.length > HIGHLIGHT_MAX ? null : highlightedHtml(props.code, props.lang)));

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
        <Show when={isMarkdown()}>
          <button
            type="button"
            class={styles.codeBtn}
            aria-label={preview() ? "Show markdown source" : "Preview markdown"}
            aria-pressed={preview()}
            onClick={() => setPreview(!preview())}
          >
            <Icon icon={preview() ? Code : Eye} size={13} aria-hidden="true" />
          </button>
        </Show>
        <button type="button" class={styles.codeBtn} aria-label="Copy code" onClick={copy}>
          <Icon icon={copied() ? Check : Copy} size={13} aria-hidden="true" />
        </button>
        <Show when={props.lang}>
          <span class={styles.codeLang}>{props.lang}</span>
        </Show>
      </div>
      <Show
        when={!preview()}
        fallback={
          <div
            class={styles.codePreview}
            innerHTML={sanitizeHtml(marked.parse(stripFrontMatter(props.code)) as string)}
          />
        }
      >
        <pre>
          <Show when={html()} fallback={<code>{props.code}</code>}>
            {(h) => <code innerHTML={h()} />}
          </Show>
        </pre>
      </Show>
    </div>
  );
}

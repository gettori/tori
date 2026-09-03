import { Show, createSignal, onCleanup } from "solid-js";
import { Check, Copy } from "lucide-solid";
import { copyText } from "../../utils/clipboard";
import Icon from "../../components/Icon/Icon";
import Diagram from "../../components/Diagram/Diagram";
import styles from "./MarkdownPreview.module.css";

/**
 * One fenced block inside a rendered markdown file. The reason it is a
 * component rather than the `<pre>` marked already emits: rendered is the side
 * you read from, so it is the side that owes you the text back, and a `mermaid`
 * fence is a picture here rather than nine lines of arrow syntax.
 */
export default function PreviewCode(props: { lang: string; code: string }) {
  const [copied, setCopied] = createSignal(false);
  const isMermaid = () => /^mermaid$/i.test(props.lang);

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
      {/* The diagram's source, not its SVG: what you would paste back into a
          markdown file is the fence, and the picture is not editable text. */}
      <button type="button" class={styles.copyBtn} aria-label="Copy code" onClick={copy}>
        <Icon icon={copied() ? Check : Copy} size={13} aria-hidden="true" />
      </button>
      <Show when={!isMermaid()} fallback={<Diagram code={props.code} />}>
        <pre>
          <code>{props.code}</code>
        </pre>
      </Show>
    </div>
  );
}

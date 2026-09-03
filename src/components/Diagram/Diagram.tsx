import { Match, Switch, createResource, createSignal, onCleanup } from "solid-js";
import { on as onEvent, THEME_APPLIED } from "../../utils/events";
import styles from "./Diagram.module.css";

type Engine = typeof import("../../utils/mermaidEngine");

let engine: Engine | null = null;

async function loadEngine(): Promise<Engine> {
  engine ??= await import("../../utils/mermaidEngine");
  return engine;
}

/**
 * One `mermaid` fence, drawn. Mermaid is a megabyte of graph layout, so it is
 * fetched on first sight of a diagram and never before; until it lands, and for
 * a fence that does not parse, the source stands in for the picture.
 *
 * The SVG goes into innerHTML unsanitized on purpose. Mermaid's own strict mode
 * DOMPurifies what it returns, and our sanitizer would strip the `<style>` block
 * the diagram's colours live in, leaving an unreadable black-on-black graph.
 */
export default function Diagram(props: { code: string }) {
  // A theme switch changes the seeds mermaid derives its palette from, and the
  // palette is baked into the SVG, so the diagram has to be drawn again.
  const [theme, setTheme] = createSignal(0);
  onCleanup(onEvent(THEME_APPLIED, () => setTheme((n) => n + 1)));

  const [svg] = createResource(
    () => [props.code, theme()] as const,
    async ([code]) => {
      try {
        const m = await loadEngine();
        m.configure();
        return await m.render(code);
      } catch {
        // A failed chunk load is answered the same way an unparseable fence is:
        // the source stands in, and nothing retries because nothing would change.
        return null;
      }
    },
  );

  // `latest` rather than the value: while a streaming fence re-renders, the
  // diagram already on screen stays there instead of blanking every delta.
  const drawn = () => svg.latest;

  return (
    <Switch>
      <Match when={drawn()}>{(html) => <div class={styles.diagram} innerHTML={html()} />}</Match>
      <Match when={drawn() === null}>
        {/* Unclassed on purpose: it should wear whatever frame the surrounding
            markdown gives every other fence, in the chat and in the preview. */}
        <pre>
          <code>{props.code}</code>
        </pre>
      </Match>
    </Switch>
  );
}

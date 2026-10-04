import { Match, Switch, createEffect, createResource, createSignal, onCleanup } from "solid-js";
import { on as onEvent, THEME_APPLIED } from "../../utils/events";
import { traceAsyncWork } from "../../utils/perfTrace";
import styles from "./Diagram.module.css";

type Engine = typeof import("../../utils/mermaidEngine");

let engine: Engine | null = null;

async function loadEngine(): Promise<Engine> {
  engine ??= await import("../../utils/mermaidEngine");
  return engine;
}

// WebKit ships no requestIdleCallback, so the next frame's paint stands in: a
// render queued there still lets the frame before it draw.
function idle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: 1000 });
    else if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(resolve, 0));
    else setTimeout(resolve, 0);
  });
}

// One render at a time, each in its own idle slot: ten diagrams arriving
// together used to lay out in one frame and hold it for over 400ms.
let queue: Promise<unknown> = Promise.resolve();
const STUCK_MS = 10_000;

function inTurn<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(idle).then(fn);
  // A render that never settles must not hold every later diagram behind it.
  queue = Promise.race([run.catch(() => {}), new Promise((r) => setTimeout(r, STUCK_MS))]);
  return run;
}

/**
 * One `mermaid` fence, drawn. Mermaid is a megabyte of graph layout, so it is
 * fetched on first sight of a diagram and never before, and a diagram is only
 * drawn once it comes near the screen. Until then, and for a fence that does
 * not parse, the source stands in for the picture.
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

  // No observer at all (tests) means always on screen.
  const [visible, setVisible] = createSignal(typeof IntersectionObserver === "undefined");
  const [el, setEl] = createSignal<Element>();
  createEffect(() => {
    const node = el();
    if (!node || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)), {
      rootMargin: "200px",
    });
    io.observe(node);
    onCleanup(() => io.disconnect());
  });

  // Latched: a diagram scrolled past stays drawn rather than being laid out
  // again on the way back. A theme switch reaches it only once it is on screen
  // again, so a switch redraws what is in view and not the whole transcript.
  const [seen, setSeen] = createSignal(visible());
  const [drawnTheme, setDrawnTheme] = createSignal(theme());
  createEffect(() => {
    if (!visible()) return;
    setSeen(true);
    setDrawnTheme(theme());
  });

  const [svg] = createResource(
    () => (seen() ? ([props.code, drawnTheme()] as const) : null),
    async ([code]) => {
      try {
        const m = await loadEngine();
        return await inTurn(async () => {
          // A streaming fence queues a render per delta; only the newest is
          // kept by the resource, so the older ones need not lay out at all.
          if (code !== props.code) return null;
          m.configure();
          return traceAsyncWork("mermaid", () => m.render(code));
        });
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
      <Match when={drawn()}>{(html) => <div ref={setEl} class={styles.diagram} innerHTML={html()} />}</Match>
      <Match when={!drawn()}>
        {/* Unclassed on purpose: it should wear whatever frame the surrounding
            markdown gives every other fence, in the chat and in the preview.
            Hidden while a drawing is still coming, so it holds the space
            without flashing source that is about to be replaced. */}
        <pre ref={setEl} classList={{ [styles.pending]: drawn() === undefined }}>
          <code>{props.code}</code>
        </pre>
      </Match>
    </Switch>
  );
}

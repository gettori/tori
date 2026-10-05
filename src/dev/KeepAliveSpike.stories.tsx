import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { For, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { stageHost, dropStageHost } from "../tabs/stageHost";
import PaneTree, { type PaneRoles } from "../layout/PaneTree";
import { closePane, leaves, splitPane } from "../layout/paneLayout";
import { ensureEnvelope, envelopeFor, resetPaneLayoutModel, seedTwoPane, updateLayout } from "../layout/layoutStore";
import { mergePaneInto, moveTabToPane, paneOfTab, resetTabPlacement } from "../layout/tabPlacement";
import { registerKind } from "../tabs/registry";
import { unifiedTabs } from "../tabs/unifiedTabs";
import {
  open,
  setOpen,
  setActiveWorkspace,
  setActiveByWorkspace,
  visibleId,
} from "../panels/Terminal/terminalTabStore";
import {
  on as onEvent,
  onWith as onEventWith,
  MOVE_TAB_TO_PANE,
  type MoveTabToPane,
  SPLIT_PANE,
  type SplitPane as SplitPaneEvt,
  REFIT_PANES,
} from "../utils/events";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import "@xterm/xterm/css/xterm.css";

/** Phase 1 keep-alive spike, driven by dev/keepalive-probe.mjs over CDP.
 *  Each story exposes window.__spikeRun() returning raw measurements; the
 *  probe applies the pass criteria recorded in the plan. Not part of the app. */

const meta = {
  title: "Dev/KeepAliveSpike",
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

type SpikeResult = Record<string, unknown>;

declare global {
  interface Window {
    __spikeRun?: () => Promise<SpikeResult>;
    /** Phase 10 only: the points a trusted drag has to press and drop on. */
    __spikePrep?: () => Promise<SpikeResult>;
  }
}

const BOX = { width: "480px", height: "240px", border: "1px solid currentColor", overflow: "hidden" };
const SLOT = { width: "320px", height: "200px", border: "1px solid currentColor", overflow: "hidden" };

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

function trackErrors() {
  let n = 0;
  const seen: string[] = [];
  const bump = (e: Event) => {
    n++;
    const err = e as ErrorEvent & PromiseRejectionEvent;
    seen.push(String(err.message ?? err.reason ?? e.type));
  };
  window.addEventListener("error", bump);
  window.addEventListener("unhandledrejection", bump);
  return {
    count: () => n,
    messages: () => seen,
    stop: () => {
      window.removeEventListener("error", bump);
      window.removeEventListener("unhandledrejection", bump);
    },
  };
}

function seqLines(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `line-${String(i + 1).padStart(4, "0")} lorem ipsum dolor sit`);
}

function makeTerm(host: HTMLElement) {
  const term = new Terminal({ fontSize: 12, scrollback: 1000 });
  const fit = new FitAddon();
  term.loadAddon(fit);
  let lost = 0;
  let webglActive = false;
  term.open(host);
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      lost++;
    });
    term.loadAddon(webgl);
    webglActive = true;
  } catch {
    // WebGL unavailable: xterm keeps the DOM renderer, recorded in the result.
  }
  fit.fit();
  return { term, fit, contextLost: () => lost, webglActive: () => webglActive };
}

function writeAll(term: Terminal, lines: string[]): Promise<void> {
  return new Promise((r) => term.write(lines.join("\r\n") + "\r\n", r));
}

async function renderedAfterWrite(term: Terminal, marker: string, timeoutMs = 2000): Promise<boolean> {
  // Drain repaints already scheduled (scroll, fit) so a subsequent onRender
  // attributes to this write, not to a stale frame.
  await frame();
  await frame();
  return new Promise((resolve) => {
    const d = term.onRender(() => {
      d.dispose();
      clearTimeout(t);
      resolve(true);
    });
    const t = setTimeout(() => {
      d.dispose();
      resolve(false);
    }, timeoutMs);
    term.write(marker + "\r\n");
  });
}

function lastLines(term: Terminal, n: number): string[] {
  const buf = term.buffer.active;
  const out: string[] = [];
  for (let i = Math.max(0, buf.length - n); i < buf.length; i++) {
    out.push(buf.getLine(i)?.translateToString(true) ?? "");
  }
  return out;
}

function termSnapshot(term: Terminal) {
  return {
    length: term.buffer.active.length,
    viewportY: term.buffer.active.viewportY,
    markerLine: term.buffer.active.getLine(41)?.translateToString(true) ?? "",
  };
}

export const Xterm: Story = {
  render: () => {
    let b!: HTMLDivElement;
    let wrap!: HTMLDivElement;
    let cleanups = 0;
    onCleanup(() => {
      cleanups++;
    });
    onMount(() => {
      window.__spikeRun = async () => {
        const errs = trackErrors();
        const { term, fit, contextLost, webglActive } = makeTerm(wrap);
        await writeAll(term, seqLines(300));
        term.scrollLines(-100);
        await frame();
        const before = termSnapshot(term);
        b.appendChild(wrap);
        fit.fit();
        await frame();
        const natural = termSnapshot(term);
        // A write below a scrolled-up viewport repaints nothing, so the render
        // check must run at the bottom; the scroll state is restored after.
        term.scrollToBottom();
        const rendered = await renderedAfterWrite(term, "post-move-marker");
        term.scrollToLine(before.viewportY);
        const restoredViewportY = term.buffer.active.viewportY;
        const tail = lastLines(term, 5).join("\n");
        errs.stop();
        return {
          scenario: "xterm",
          webglActive: webglActive(),
          contextLost: contextLost(),
          before,
          natural,
          restoredViewportY,
          rendered,
          postMoveMarkerFound: tail.includes("post-move-marker"),
          hostConnected: wrap.isConnected,
          hostParent: wrap.parentElement?.dataset.c ?? null,
          cleanups,
          errors: errs.count(),
        };
      };
    });
    return (
      <div style={{ display: "flex", gap: "12px" }}>
        <div data-c="a" style={BOX}>
          <div ref={wrap} style={{ width: "100%", height: "100%" }} />
        </div>
        <div data-c="b" ref={b} style={BOX} />
      </div>
    );
  },
};

export const Editor: Story = {
  render: () => {
    let b!: HTMLDivElement;
    let wrap!: HTMLDivElement;
    let cleanups = 0;
    onCleanup(() => {
      cleanups++;
    });
    onMount(() => {
      window.__spikeRun = async () => {
        const errs = trackErrors();
        const view = new EditorView({
          state: EditorState.create({
            doc: seqLines(400).join("\n"),
            extensions: [EditorView.theme({ "&": { height: "100%" } })],
          }),
          parent: wrap,
        });
        view.dispatch({ selection: { anchor: 500 } });
        await frame();
        view.scrollDOM.scrollTop = 1200;
        await frame();
        const before = {
          doc: view.state.doc.length,
          head: view.state.selection.main.head,
          scrollTop: view.scrollDOM.scrollTop,
        };
        b.appendChild(wrap);
        const naturalScrollTop = view.scrollDOM.scrollTop;
        view.scrollDOM.scrollTop = before.scrollTop;
        view.requestMeasure();
        await frame();
        await frame();
        const restoredScrollTop = view.scrollDOM.scrollTop;
        view.dispatch({ changes: { from: 0, insert: "post-move " } });
        const readBack = view.state.sliceDoc(0, 9);
        const after = {
          doc: view.state.doc.length,
          head: view.state.selection.main.head,
        };
        errs.stop();
        return {
          scenario: "editor",
          before,
          naturalScrollTop,
          restoredScrollTop,
          after,
          readBack,
          hostConnected: wrap.isConnected,
          hostParent: wrap.parentElement?.dataset.c ?? null,
          cleanups,
          errors: errs.count(),
        };
      };
    });
    return (
      <div style={{ display: "flex", gap: "12px" }}>
        <div data-c="a" style={BOX}>
          <div ref={wrap} style={{ width: "100%", height: "100%" }} />
        </div>
        <div data-c="b" ref={b} style={BOX} />
      </div>
    );
  },
};

export const Chat: Story = {
  render: () => {
    let b!: HTMLDivElement;
    let wrap!: HTMLDivElement;
    let scroller!: HTMLDivElement;
    let ta!: HTMLTextAreaElement;
    let cleanups = 0;
    onCleanup(() => {
      cleanups++;
    });
    onMount(() => {
      window.__spikeRun = async () => {
        const errs = trackErrors();
        ta.focus();
        scroller.scrollTop = 1500;
        await frame();
        const before = { scrollTop: scroller.scrollTop, focused: document.activeElement === ta };
        b.appendChild(wrap);
        const naturalScrollTop = scroller.scrollTop;
        const naturalFocused = document.activeElement === ta;
        scroller.scrollTop = before.scrollTop;
        ta.focus();
        await frame();
        errs.stop();
        return {
          scenario: "chat",
          before,
          naturalScrollTop,
          naturalFocused,
          restoredScrollTop: scroller.scrollTop,
          restoredFocused: document.activeElement === ta,
          hostConnected: wrap.isConnected,
          hostParent: wrap.parentElement?.dataset.c ?? null,
          cleanups,
          errors: errs.count(),
        };
      };
    });
    return (
      <div style={{ display: "flex", gap: "12px" }}>
        <div data-c="a" style={BOX}>
          <div ref={wrap} style={{ width: "100%", height: "100%", display: "flex", "flex-direction": "column" }}>
            <div ref={scroller} style={{ flex: "1", overflow: "auto" }}>
              {seqLines(300).map((l) => (
                <div>{l}</div>
              ))}
            </div>
            <textarea ref={ta} rows="2" />
          </div>
        </div>
        <div data-c="b" ref={b} style={BOX} />
      </div>
    );
  },
};

export const Stage: Story = {
  render: () => {
    const p1 = { id: "p1" };
    const p2 = { id: "p2" };
    const p3 = { id: "p3" };
    const p4 = { id: "p4" };
    const [panes, setPanes] = createSignal([p1, p2, p3]);
    let stage!: HTMLDivElement;
    const disposedSlots: string[] = [];
    onMount(() => {
      window.__spikeRun = async () => {
        const errs = trackErrors();
        const host = document.createElement("div");
        host.style.width = "100%";
        host.style.height = "100%";
        stage.appendChild(host);
        const { term, fit, contextLost, webglActive } = makeTerm(host);
        await writeAll(term, seqLines(300));
        const before = termSnapshot(term);
        const slot = document.querySelector('[data-slot="p2"]') as HTMLElement;
        slot.appendChild(host);
        fit.fit();
        setPanes([p3, p2, p4]);
        await frame();
        await frame();
        const rendered = await renderedAfterWrite(term, "post-move-marker");
        const after = termSnapshot(term);
        errs.stop();
        return {
          scenario: "stage",
          webglActive: webglActive(),
          contextLost: contextLost(),
          before,
          after,
          rendered,
          hostConnected: host.isConnected,
          hostSlot: host.parentElement?.dataset.slot ?? null,
          sameElement: host === document.querySelector('[data-slot="p2"]')?.firstElementChild,
          disposedSlots: [...disposedSlots],
          errors: errs.count(),
        };
      };
    });
    return (
      <div>
        <div ref={stage} data-stage style={BOX} />
        <div style={{ display: "flex", gap: "8px" }}>
          <For each={panes()}>
            {(p) => {
              onCleanup(() => disposedSlots.push(p.id));
              return <div data-slot={p.id} style={SLOT} />;
            }}
          </For>
        </div>
      </div>
    );
  },
};

export const Registry: Story = {
  render: () => {
    const r1 = { id: "r1" };
    const r2 = { id: "r2" };
    const r3 = { id: "r3" };
    const [rows, setRows] = createSignal<{ id: string }[]>([]);
    const registry = new Map<string, HTMLDivElement>();
    const disposedRows: string[] = [];
    onMount(() => {
      window.__spikeRun = async () => {
        const errs = trackErrors();
        for (const id of ["r1", "r2", "r3"]) {
          const host = document.createElement("div");
          host.style.width = "100%";
          host.style.height = "100%";
          if (id !== "r1") {
            const sc = document.createElement("div");
            sc.style.height = "100%";
            sc.style.overflow = "auto";
            sc.dataset.scroller = id;
            for (const l of seqLines(200)) {
              const row = document.createElement("div");
              row.textContent = l;
              sc.appendChild(row);
            }
            host.appendChild(sc);
          }
          registry.set(id, host);
        }
        setRows([r1, r2, r3]);
        await frame();
        const r1host = registry.get("r1")!;
        const { term, fit, contextLost, webglActive } = makeTerm(r1host);
        await writeAll(term, seqLines(300));
        const sc2 = registry.get("r2")!.firstElementChild as HTMLElement;
        sc2.scrollTop = 900;
        await frame();
        const scrollBefore = sc2.scrollTop;

        setRows([r2, r1, r3]);
        await frame();
        const reorderScrollNatural = sc2.scrollTop;
        const reorderAlive = await renderedAfterWrite(term, "post-reorder-marker");

        setRows([r2, r1]);
        await frame();
        const r3DetachedRetained = !registry.get("r3")!.isConnected && registry.get("r3")!.childElementCount === 1;
        setRows([r2, r1, r3]);
        await frame();
        const sc3 = registry.get("r3")!.firstElementChild as HTMLElement;
        const readdScrollNatural = sc3.scrollTop;

        setRows([r2, r3]);
        await frame();
        const termDetached = !r1host.isConnected;
        setRows([r2, r1, r3]);
        await frame();
        fit.fit();
        const redetachAlive = await renderedAfterWrite(term, "post-redetach-marker");
        const after = termSnapshot(term);
        errs.stop();
        return {
          scenario: "registry",
          webglActive: webglActive(),
          contextLost: contextLost(),
          scrollBefore,
          reorderScrollNatural,
          reorderAlive,
          r3DetachedRetained,
          readdScrollNatural,
          termDetached,
          redetachAlive,
          bufferLength: after.length,
          markerLine: after.markerLine,
          hostsConnected: ["r1", "r2", "r3"].map((id) => registry.get(id)!.isConnected),
          hostsUnderOwnRow: ["r1", "r2", "r3"].map((id) => registry.get(id)!.parentElement?.dataset.row === id),
          disposedRows: [...disposedRows],
          errors: errs.count(),
        };
      };
    });
    return (
      <div style={{ display: "flex", gap: "8px" }}>
        <For each={rows()}>
          {(r) => {
            onCleanup(() => disposedRows.push(r.id));
            let el!: HTMLDivElement;
            onMount(() => el.appendChild(registry.get(r.id)!));
            return <div data-row={r.id} ref={el} style={SLOT} />;
          }}
        </For>
      </div>
    );
  },
};

export const Viewport: Story = {
  render: () => {
    const q1 = { id: "q1" };
    const q2 = { id: "q2" };
    const q3 = { id: "q3" };
    const [panes, setPanes] = createSignal([q1, q2]);
    let root!: HTMLDivElement;
    const hosts = new Map<string, HTMLDivElement>();

    function place() {
      const rootRect = root.getBoundingClientRect();
      for (const p of panes()) {
        const slot = root.querySelector(`[data-vslot="${p.id}"]`) as HTMLElement | null;
        const host = hosts.get(p.id);
        if (!slot || !host) continue;
        const r = slot.getBoundingClientRect();
        host.style.left = `${r.left - rootRect.left}px`;
        host.style.top = `${r.top - rootRect.top}px`;
        host.style.width = `${r.width}px`;
        host.style.height = `${r.height}px`;
      }
    }

    function maxDelta(): number {
      let d = 0;
      for (const p of panes()) {
        const slot = root.querySelector(`[data-vslot="${p.id}"]`)!.getBoundingClientRect();
        const host = hosts.get(p.id)!.getBoundingClientRect();
        d = Math.max(
          d,
          Math.abs(slot.left - host.left),
          Math.abs(slot.top - host.top),
          Math.abs(slot.right - host.right),
          Math.abs(slot.bottom - host.bottom),
        );
      }
      return d;
    }

    onMount(() => {
      const ro = new ResizeObserver(() => place());
      ro.observe(root);
      onCleanup(() => ro.disconnect());
      window.__spikeRun = async () => {
        const errs = trackErrors();
        for (const id of ["q1", "q2", "q3"]) {
          const host = document.createElement("div");
          host.style.position = "absolute";
          host.textContent = `host-${id}`;
          host.dataset.vhost = id;
          root.appendChild(host);
          hosts.set(id, host);
        }
        const sc = document.createElement("div");
        sc.style.height = "100%";
        sc.style.overflow = "auto";
        for (const l of seqLines(120)) {
          const row = document.createElement("div");
          row.textContent = l;
          sc.appendChild(row);
        }
        hosts.get("q1")!.appendChild(sc);
        place();
        await frame();
        sc.scrollTop = 700;
        await frame();
        const initialDelta = maxDelta();
        const scrollBefore = sc.scrollTop;
        setPanes([q2, q3, q1]);
        await frame();
        place();
        await frame();
        const patchDelta = maxDelta();
        root.style.width = "640px";
        await frame();
        await frame();
        const resizeDelta = maxDelta();
        errs.stop();
        return {
          scenario: "viewport",
          initialDelta,
          patchDelta,
          resizeDelta,
          scrollBefore,
          scrollAfter: sc.scrollTop,
          hostsConnected: ["q1", "q2", "q3"].map((id) => hosts.get(id)!.isConnected),
          errors: errs.count(),
        };
      };
    });
    return (
      <div ref={root} style={{ position: "relative", width: "960px", height: "260px" }}>
        <div style={{ display: "flex", gap: "8px", height: "100%" }}>
          <For each={panes()}>
            {(p) => <div data-vslot={p.id} style={{ flex: "1", border: "1px solid currentColor" }} />}
          </For>
        </div>
      </div>
    );
  },
};

export const ForOwned: Story = {
  render: () => {
    const f1 = { id: "f1" };
    const f2 = { id: "f2" };
    const f3 = { id: "f3" };
    const [rows, setRows] = createSignal([f1, f2, f3]);
    let outside!: HTMLDivElement;
    const disposedRows: string[] = [];
    onMount(() => {
      window.__spikeRun = async () => {
        const errs = trackErrors();
        const el = document.querySelector('[data-forrow="f1"]') as HTMLElement;
        outside.appendChild(el);
        const movedOk = el.parentElement === outside;
        // Solid's flush can throw synchronously out of the setter; the throw is
        // itself a measurement here, so catch and record rather than abort.
        let reorderThrew: string | null = null;
        let removeThrew: string | null = null;
        try {
          setRows([f2, f1, f3]);
        } catch (e) {
          reorderThrew = String(e);
        }
        await frame();
        const afterReorder = {
          connected: el.isConnected,
          parent: el.parentElement?.dataset.c ?? el.parentElement?.dataset.forlist ?? null,
        };
        try {
          setRows([f2, f3]);
        } catch (e) {
          removeThrew = String(e);
        }
        await frame();
        const afterRemove = {
          connected: el.isConnected,
          parent: el.parentElement?.dataset.c ?? el.parentElement?.dataset.forlist ?? null,
        };
        errs.stop();
        return {
          scenario: "forowned",
          movedOk,
          reorderThrew,
          removeThrew,
          afterReorder,
          afterRemove,
          disposedRows: [...disposedRows],
          errors: errs.count(),
        };
      };
    });
    return (
      <div style={{ display: "flex", gap: "12px" }}>
        <div data-forlist="list" style={{ display: "flex", gap: "8px" }}>
          <For each={rows()}>
            {(r) => {
              onCleanup(() => disposedRows.push(r.id));
              return (
                <div data-forrow={r.id} style={SLOT}>
                  row {r.id}
                </div>
              );
            }}
          </For>
        </div>
        <div data-c="outside" ref={outside} style={SLOT} />
      </div>
    );
  },
};

/** Phase 7's shape end to end: a surface Portal-rendered into a module-owned
 *  stage host, adopted by a slot, then re-hosted A -> B -> A the way a pane
 *  move will. The xterm stands in for the PTY, as in the stories above. */
export const StageHostCycle: Story = {
  render: () => {
    let slotA!: HTMLDivElement;
    let slotB!: HTMLDivElement;
    let surface!: HTMLDivElement;
    onMount(() => {
      window.__spikeRun = async () => {
        const errs = trackErrors();
        const host = stageHost("p7-term");
        slotA.appendChild(host);
        await frame();
        const { term, fit, contextLost, webglActive } = makeTerm(surface);
        await writeAll(term, seqLines(300));
        const adoptedInA = host.parentElement === slotA && surface.isConnected;

        slotB.appendChild(host);
        await frame();
        fit.fit();
        const inB = host.parentElement === slotB;
        const aliveAfterAtoB = await renderedAfterWrite(term, "post-rehost-marker");

        slotA.appendChild(host);
        await frame();
        fit.fit();
        const backInA = host.parentElement === slotA;
        const aliveAfterBtoA = await renderedAfterWrite(term, "post-return-marker");
        const after = termSnapshot(term);

        dropStageHost("p7-term");
        const droppedGone = !host.isConnected && stageHost("p7-term") !== host;
        dropStageHost("p7-term");
        errs.stop();
        return {
          scenario: "stagehostcycle",
          webglActive: webglActive(),
          contextLost: contextLost(),
          adoptedInA,
          inB,
          aliveAfterAtoB,
          backInA,
          aliveAfterBtoA,
          bufferLength: after.length,
          droppedGone,
          errors: errs.count(),
        };
      };
    });
    return (
      <div style={{ display: "flex", gap: "12px" }}>
        {/* Fixed px, not 100%: the wrapper div Portal inserts only collapses
            via App.css's display:contents rule, which Storybook does not load. */}
        <Portal mount={stageHost("p7-term")}>
          <div ref={surface} style={{ width: "318px", height: "198px" }} />
        </Portal>
        <div data-slot="a" ref={slotA} style={SLOT} />
        <div data-slot="b" ref={slotB} style={SLOT} />
      </div>
    );
  },
};

/** Phase 8: the real machinery (layout store, placement, PaneTree, PaneView)
 *  moving a live xterm from one pane to another and back, driven by
 *  dev/p8-move-probe.mjs. The xterm stands in for the PTY surface, as in the
 *  phase 1 spike: Storybook has no Tauri backend to spawn one. */
const P8_WS = "spike-ws";

const P8_CSS = `
.pane-split { display: flex; min-width: 0; min-height: 0; }
.pane-split.row { flex-direction: row; }
.pane-split.column { flex-direction: column; }
.pane { display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
.pane-split.filler, .pane-slot.filler, .pane.filler { flex: 1 1 auto; }
.pane-slot.sized, .pane.sized { flex: 0 0 auto; }
.pane-slot { display: flex; min-width: 0; min-height: 0; }
.pane.hidden, .pane-slot.hidden { display: none; }
.chrome-slot, [data-stage-host], [data-stage-host] > div { display: contents; }
`;

export const PaneMoveCycle: Story = {
  render: () => {
    const term1 = {
      id: "sh:1",
      title: "one",
      cwd: "/tmp",
      workspace: P8_WS,
      kind: "shell" as const,
      program: "",
      args: [],
      profile: null,
    };
    const term2 = {
      id: "sh:2",
      title: "two",
      cwd: "/tmp",
      workspace: P8_WS,
      kind: "shell" as const,
      program: "",
      args: [],
      profile: null,
    };
    let live: ReturnType<typeof makeTerm> | undefined;
    // The other pane's surface is a CM6 view, so the same run shows both kinds
    // of stage re-measuring as the tree changes shape around them.
    let cm: EditorView | undefined;
    const cmWidth = () => cm?.contentDOM.clientWidth ?? 0;

    localStorage.removeItem("tori.panes.v1");
    localStorage.removeItem("tori.tabpanes.v1");
    resetPaneLayoutModel();
    resetTabPlacement();
    setOpen([term1, term2]);
    setActiveWorkspace(P8_WS);
    setActiveByWorkspace({ [P8_WS]: "sh:1" });
    ensureEnvelope(P8_WS, () => seedTwoPane({ rightShare: 40, showLeft: true, showRight: true }));
    for (const kind of ["shell"] as const) {
      registerKind(kind, {
        icon: () => undefined,
        title: (u) => u.id,
        tooltip: (u) => u.id,
        renderMenuItem: (u) => <span>{u.id}</span>,
        activate: () => {},
        close: () => {},
        stripItems: () => unifiedTabs().filter((u) => u.workspace === P8_WS),
        stripActiveId: () => visibleId(),
        stripReorder: () => {},
        hostIds: () => open().map((t) => t.id),
      });
    }
    const root = () =>
      envelopeFor(P8_WS, () => seedTwoPane({ rightShare: 40, showLeft: true, showRight: true })).layout;
    const tabs = () => open().map((t) => ({ id: t.id, kind: t.kind }));
    const paneOf = (id: string) => stageHost(id).closest("[data-pane-id]")?.getAttribute("data-pane-id") ?? null;

    onMount(() => {
      // The app refits on REFIT_PANES; this story is the app for that purpose.
      const off = onEvent(REFIT_PANES, () => {
        live?.fit.fit();
        cm?.requestMeasure();
      });
      onCleanup(off);
      window.__spikeRun = async () => {
        const errs = trackErrors();
        await frame();
        await writeAll(live!.term, seqLines(300));
        const startedIn = paneOf("sh:1");
        const colsBefore = live!.term.cols;
        const cmBefore = cmWidth();

        updateLayout(P8_WS, (r) =>
          splitPane(r, "left", "row", { type: "pane", id: "pane-1", size: 50, hidden: false }),
        );
        await frame();
        const refusal = moveTabToPane({
          ws: P8_WS,
          tab: { id: "sh:1", kind: "shell" },
          targetPaneId: "pane-1",
          root: root(),
          tabsInWs: tabs(),
        });
        await frame();
        await frame();
        const movedTo = paneOf("sh:1");
        const aliveAfterMove = await renderedAfterWrite(live!.term, "post-move-marker");
        const colsAfterMove = live!.term.cols;
        const cmAfterMove = cmWidth();

        mergePaneInto({ ws: P8_WS, from: "pane-1", to: "left", root: root(), tabsInWs: tabs() });
        updateLayout(P8_WS, (r) => closePane(r, "pane-1"));
        await frame();
        await frame();
        const mergedTo = paneOf("sh:1");
        const aliveAfterMerge = await renderedAfterWrite(live!.term, "post-merge-marker");
        const after = termSnapshot(live!.term);
        errs.stop();
        return {
          scenario: "panemovecycle",
          webglActive: live!.webglActive(),
          contextLost: live!.contextLost(),
          refusal,
          startedIn,
          movedTo,
          mergedTo,
          aliveAfterMove,
          aliveAfterMerge,
          colsBefore,
          colsAfterMove,
          colsAfterMerge: live!.term.cols,
          cmBefore,
          cmAfterMove,
          cmAfterMerge: cmWidth(),
          bufferLength: after.length,
          errors: errs.count(),
          errorMessages: errs.messages(),
        };
      };
    });

    const roles: PaneRoles = {
      ws: P8_WS,
      pinKindOf: () => "shell",
      roleOf: () => "split",
      px: (n) => n,
      onResize: () => {},
      onCommit: () => {},
    };
    return (
      <div style={{ width: "900px", height: "360px", display: "flex" }}>
        <style>{P8_CSS}</style>
        <Portal mount={stageHost("sh:1")}>
          <div style={{ width: "100%", height: "100%" }} ref={(el) => queueMicrotask(() => (live = makeTerm(el)))} />
        </Portal>
        <Portal mount={stageHost("sh:2")}>
          <div
            style={{ width: "100%", height: "100%" }}
            ref={(el) =>
              queueMicrotask(() => {
                cm = new EditorView({ state: EditorState.create({ doc: seqLines(80).join("\n") }), parent: el });
              })
            }
          />
        </Portal>
        <PaneTree node={root()} roles={roles} />
      </div>
    );
  },
};

/** Phase 10: a real drag, driven by dev/p10-drag-probe.mjs over CDP. The story
 *  is the shell for this purpose (it runs the pane edits the events ask for),
 *  and `__spikePrep` hands the probe the points to press and drop on, since
 *  only trusted input can start a drag the browser believes in. */
const P10_WS = "drag-ws";

export const TabDragCycle: Story = {
  render: () => {
    const mk = (id: string) => ({
      id,
      title: id,
      cwd: "/tmp",
      workspace: P10_WS,
      kind: "shell" as const,
      program: "",
      args: [],
      profile: null,
    });
    let live: ReturnType<typeof makeTerm> | undefined;

    localStorage.removeItem("tori.panes.v1");
    localStorage.removeItem("tori.tabpanes.v1");
    resetPaneLayoutModel();
    resetTabPlacement();
    setOpen([mk("sh:1"), mk("sh:2")]);
    setActiveWorkspace(P10_WS);
    setActiveByWorkspace({ [P10_WS]: "sh:1" });
    ensureEnvelope(P10_WS, () => seedTwoPane({ rightShare: 50, showLeft: true, showRight: true }));
    registerKind("shell", {
      icon: () => undefined,
      title: (u) => u.id,
      tooltip: (u) => u.id,
      renderMenuItem: (u) => <span>{u.id}</span>,
      activate: () => {},
      close: () => {},
      stripItems: () => unifiedTabs().filter((u) => u.workspace === P10_WS),
      stripActiveId: () => visibleId(),
      stripReorder: () => {},
      hostIds: (_paneId, tabs) => tabs.map((t) => t.id),
    });
    const root = () =>
      envelopeFor(P10_WS, () => seedTwoPane({ rightShare: 50, showLeft: true, showRight: true })).layout;
    const tabs = () => open().map((t) => ({ id: t.id, kind: t.kind }));
    const paneOf = (id: string) => stageHost(id).closest("[data-pane-id]")?.getAttribute("data-pane-id") ?? null;
    const center = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    };
    const el = (sel: string) => document.querySelector(sel)!;

    onMount(() => {
      const off = onEvent(REFIT_PANES, () => live?.fit.fit());
      onCleanup(off);
      // The shell's half of a drop: the pane emits, this runs the edit.
      const offMove = onEventWith<MoveTabToPane>(MOVE_TAB_TO_PANE, (p) => {
        const tab = tabs().find((t) => t.id === p.tabId);
        if (!tab || !p.paneId) return;
        moveTabToPane({ ws: P10_WS, tab, targetPaneId: p.paneId, root: root(), tabsInWs: tabs() });
      });
      const offSplit = onEventWith<SplitPaneEvt>(SPLIT_PANE, (p) => {
        const id = `pane-${leaves(root()).length}`;
        updateLayout(P10_WS, (r) =>
          splitPane(r, p.paneId ?? "left", p.dir, { type: "pane", id, size: 50, hidden: false }, p.pos),
        );
        const tab = tabs().find((t) => t.id === p.tabId);
        if (tab) moveTabToPane({ ws: P10_WS, tab, targetPaneId: id, root: root(), tabsInWs: tabs() });
      });
      onCleanup(() => {
        offMove();
        offSplit();
      });

      window.__spikePrep = async () => {
        await frame();
        await writeAll(live!.term, seqLines(300));
        const tabEl = el('[data-pane-id="left"] .otab-list [data-tab-id="sh:1"]');
        const rightPane = el('[data-pane-id="right"]').getBoundingClientRect();
        // `.otab-list` is `display: contents` and has no box of its own; the
        // strip is the row above it.
        const rightStrip = el('[data-pane-id="right"] .otab-list').parentElement!.getBoundingClientRect();
        return {
          tab: center(tabEl),
          strip: {
            x: Math.round(rightStrip.left + rightStrip.width - 20),
            y: Math.round(rightStrip.top + rightStrip.height / 2),
          },
          stripBox: { x: rightStrip.left, y: rightStrip.top, w: rightStrip.width, h: rightStrip.height },
          edge: { x: Math.round(rightPane.left + 10), y: Math.round(rightPane.top + rightPane.height / 2) },
          startedIn: paneOf("sh:1"),
          colsBefore: live!.term.cols,
          bufferBefore: termSnapshot(live!.term).length,
        };
      };
      window.__spikeRun = async () => {
        const errs = trackErrors();
        await frame();
        await frame();
        const zones = document.querySelectorAll("[data-drop-zone]").length;
        const alive = await renderedAfterWrite(live!.term, "post-drag-marker");
        errs.stop();
        return {
          scenario: "tabdragcycle",
          webglActive: live!.webglActive(),
          contextLost: live!.contextLost(),
          movedTo: paneOf("sh:1"),
          paneCount: leaves(root()).length,
          tabsRight: unifiedTabs()
            .filter((t) => paneOfTab(P10_WS, t, root()) === "right")
            .map((t) => t.id),
          zonesLeftOver: zones,
          aliveAfterDrag: alive,
          cols: live!.term.cols,
          bufferLength: termSnapshot(live!.term).length,
          errors: errs.count(),
          errorMessages: errs.messages(),
        };
      };
    });

    const roles: PaneRoles = {
      ws: P10_WS,
      pinKindOf: () => "shell",
      roleOf: () => "split",
      px: (n) => n,
      onResize: () => {},
      onCommit: () => {},
    };
    return (
      <div style={{ width: "900px", height: "360px", display: "flex" }}>
        <style>{P8_CSS}</style>
        <Portal mount={stageHost("sh:1")}>
          <div style={{ width: "100%", height: "100%" }} ref={(e) => queueMicrotask(() => (live = makeTerm(e)))} />
        </Portal>
        <Portal mount={stageHost("sh:2")}>
          <div style={{ width: "100%", height: "100%" }} />
        </Portal>
        <PaneTree node={root()} roles={roles} />
      </div>
    );
  },
};

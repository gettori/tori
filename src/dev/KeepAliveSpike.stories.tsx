import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { stageHost } from "../tabs/stageHost";
import PaneTree, { type PaneRoles } from "../layout/PaneTree";
import { leaves, splitPane } from "../layout/paneLayout";
import { ensureEnvelope, envelopeFor, resetPaneLayoutModel, seedTwoPane, updateLayout } from "../layout/layoutStore";
import { moveTabToPane, paneOfTab, resetTabPlacement } from "../layout/tabPlacement";
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
import "@xterm/xterm/css/xterm.css";

/** Tab drag in a real browser, driven by dev/p10-drag-probe.mjs over CDP: jsdom
 *  has no drag plumbing, so `appDragDrop.test.tsx` cannot cover that half. The
 *  story exposes window.__spikeRun() returning raw measurements. Not part of
 *  the app. */

const meta = {
  title: "Dev/KeepAliveSpike",
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

type SpikeResult = Record<string, unknown>;

declare global {
  interface Window {
    __spikeRun?: () => Promise<SpikeResult>;
    /** The points a trusted drag has to press and drop on. */
    __spikePrep?: () => Promise<SpikeResult>;
  }
}

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

function termSnapshot(term: Terminal) {
  return {
    length: term.buffer.active.length,
    viewportY: term.buffer.active.viewportY,
    markerLine: term.buffer.active.getLine(41)?.translateToString(true) ?? "",
  };
}

const PANE_CSS = `
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

/** The story is the shell for this purpose (it runs the pane edits the events
 *  ask for), and `__spikePrep` hands the probe the points to press and drop on,
 *  since only trusted input can start a drag the browser believes in. */
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
        <style>{PANE_CSS}</style>
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

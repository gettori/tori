import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Terminal } from "@xterm/xterm";
import {
  acquireWebgl,
  __setWebglAttachForTests,
  __resetWebglForTests,
  __webglStatsForTests,
  type WebglSlot,
} from "./webglLru";

// The cap and the loss limit are the module's, not the test's; these mirror them
// so a change to either shows up here as a failure rather than as a silent pass.
const CAP = 8;
const MAX_LOSSES = 3;

// Stands in for the real attach, which needs a GPU. Counting happens through the
// module's own stats; this only has to hand back something disposable and keep
// the loss callback so a test can fire it.
let losers: Map<object, () => void>;

function install() {
  losers = new Map();
  __setWebglAttachForTests((term, _host, onLoss) => {
    const handle = { dispose: () => {}, canvases: [] };
    losers.set(term, onLoss);
    return handle;
  });
}

/** One terminal's slot, with the fake terminal object as its identity. */
function slot(name: string): { term: object; webgl: WebglSlot } {
  const term = { name } as unknown as Terminal;
  return { term, webgl: acquireWebgl(term, {} as HTMLElement) };
}

beforeEach(() => {
  __resetWebglForTests();
  install();
});

afterEach(() => {
  __resetWebglForTests();
  __setWebglAttachForTests(null);
});

describe("webgl LRU", () => {
  it("caps live contexts however many terminals exist", () => {
    // 20 terminals across 6 worktrees, each revealed once as it is visited.
    const slots = Array.from({ length: 20 }, (_, i) => slot(`t${i}`));
    for (const s of slots) {
      s.webgl.reveal();
      s.webgl.conceal();
    }
    expect(__webglStatsForTests().live).toBe(CAP);
    expect(__webglStatsForTests().created).toBe(20);
    expect(__webglStatsForTests().disposed).toBe(20 - CAP);
  });

  it("never evicts a terminal that is on screen", () => {
    // Panes stay revealed: more visible terminals than the cap is a state the
    // cap must not resolve by blanking one of them.
    const visible = Array.from({ length: CAP + 2 }, (_, i) => slot(`v${i}`));
    for (const s of visible) s.webgl.reveal();
    expect(__webglStatsForTests().live).toBe(CAP + 2);
    expect(__webglStatsForTests().disposed).toBe(0);

    // Concealing two makes them the only takeable contexts, so the next reveal
    // takes both and stops there rather than reaching for a third that is on
    // screen: 9 visible terminals means 9 live contexts, over cap on purpose.
    visible[0].webgl.conceal();
    visible[1].webgl.conceal();
    slot("extra").webgl.reveal();
    expect(__webglStatsForTests().live).toBe(CAP + 1);
    expect(__webglStatsForTests().disposed).toBe(2);
  });

  it("an A/B flip inside the LRU creates and disposes nothing", () => {
    const a = slot("a");
    const b = slot("b");
    a.webgl.reveal();
    a.webgl.conceal();
    b.webgl.reveal();
    b.webgl.conceal();
    const settled = __webglStatsForTests();
    expect(settled.created).toBe(2);
    expect(settled.disposed).toBe(0);

    for (let i = 0; i < 10; i++) {
      a.webgl.reveal();
      a.webgl.conceal();
      b.webgl.reveal();
      b.webgl.conceal();
    }
    expect(__webglStatsForTests()).toEqual(settled);
  });

  it("evicts the least recently visible, not the least recently created", () => {
    const slots = Array.from({ length: CAP }, (_, i) => slot(`t${i}`));
    for (const s of slots) {
      s.webgl.reveal();
      s.webgl.conceal();
    }
    // The oldest by creation is revealed again, so the second-oldest is now the
    // one holding a context nobody has looked at for longest.
    slots[0].webgl.reveal();
    slots[0].webgl.conceal();

    const disposedBefore = __webglStatsForTests().disposed;
    slot("newcomer").webgl.reveal();
    expect(__webglStatsForTests().disposed).toBe(disposedBefore + 1);
    // Revealing slot 0 again attaches nothing: it was never the victim.
    const created = __webglStatsForTests().created;
    slots[0].webgl.reveal();
    expect(__webglStatsForTests().created).toBe(created);
  });

  it("re-attaches after a context loss instead of falling back for good", async () => {
    const a = slot("a");
    a.webgl.reveal();
    expect(__webglStatsForTests().live).toBe(1);

    losers.get(a.term)!();
    expect(__webglStatsForTests().live).toBe(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(__webglStatsForTests().live).toBe(1);
    expect(__webglStatsForTests().created).toBe(2);
  });

  it("stops re-attaching once a terminal has lost the context too often", async () => {
    const a = slot("a");
    a.webgl.reveal();
    for (let i = 0; i < MAX_LOSSES + 2; i++) {
      losers.get(a.term)?.();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(__webglStatsForTests().live).toBe(0);
    expect(__webglStatsForTests().created).toBe(MAX_LOSSES);
    // A later reveal does not restart the churn.
    a.webgl.reveal();
    expect(__webglStatsForTests().created).toBe(MAX_LOSSES);
  });

  it("a hidden terminal that loses its context is not re-attached", async () => {
    const a = slot("a");
    a.webgl.reveal();
    a.webgl.conceal();
    losers.get(a.term)!();
    await new Promise((r) => setTimeout(r, 0));
    expect(__webglStatsForTests().live).toBe(0);
    expect(__webglStatsForTests().created).toBe(1);
  });

  it("gives up on a machine with no WebGL rather than retrying every reveal", () => {
    let tries = 0;
    __setWebglAttachForTests(() => {
      tries++;
      return null;
    });
    const a = slot("a");
    for (let i = 0; i < 10; i++) {
      a.webgl.reveal();
      a.webgl.conceal();
    }
    expect(tries).toBe(MAX_LOSSES);
    expect(__webglStatsForTests().created).toBe(0);
  });

  it("release frees the context and stops counting the terminal", () => {
    const slots = Array.from({ length: CAP }, (_, i) => slot(`t${i}`));
    for (const s of slots) s.webgl.reveal();
    slots[0].webgl.release();
    expect(__webglStatsForTests().live).toBe(CAP - 1);

    // The freed headroom is real: a newcomer attaches with no eviction.
    const disposedBefore = __webglStatsForTests().disposed;
    slot("newcomer").webgl.reveal();
    expect(__webglStatsForTests().live).toBe(CAP);
    expect(__webglStatsForTests().disposed).toBe(disposedBefore);
  });
});

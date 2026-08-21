// The three tab states and the moves between them (plan phase 2). A restored
// tab is a strip entry with no process until it is reached for, so a tab now
// has a position on `inert -> open -> live` rather than simply existing.
//
// Table-driven on purpose: the rule is per kind (only chat has a readable
// middle), and the interesting half is what is *refused*, which a handful of
// hand-written cases would under-cover.
import { describe, it, expect, beforeEach } from "vitest";
import {
  advanceTabState,
  dropTabState,
  resetTerminalTabModel,
  seedInert,
  stateOnActivate,
  statesFor,
  tabState,
  type OpenTerm,
  type TabKind,
  type TabState,
} from "./terminalTabStore";

const ALL_STATES: TabState[] = ["inert", "open", "live"];
const KINDS: TabKind[] = ["shell", "agent", "command", "chat", "task"];

const tab = (over: Partial<OpenTerm> = {}): OpenTerm => ({
  id: "t1",
  title: "t",
  cwd: "/w",
  workspace: "/w",
  kind: "shell",
  program: "",
  args: [],
  ...over,
});

/** A chat that has a session, so it is not a draft. Its default is `live`, the
 *  same as any tab opened by a fork or a resume. */
const chat = (over: Partial<OpenTerm> = {}) => tab({ kind: "chat", sessionId: "s1", ...over });

beforeEach(() => resetTerminalTabModel());

describe("statesFor", () => {
  it("gives chat a readable middle and every terminal kind none", () => {
    expect(statesFor("chat")).toEqual(["inert", "open", "live"]);
    for (const kind of KINDS.filter((k) => k !== "chat")) {
      expect(statesFor(kind), kind).toEqual(["inert", "live"]);
    }
  });
});

describe("the default state", () => {
  // A tab opened by a gesture is already as far along as it goes: nothing has
  // to remember to record a state for the ordinary path.
  it("is live for every kind that spawns on mount", () => {
    for (const kind of KINDS.filter((k) => k !== "chat")) {
      expect(tabState(tab({ kind })), kind).toBe("live");
    }
    expect(tabState(chat())).toBe("live");
  });

  // A draft has no session and no child, which is the definition of `open`.
  it("is open for a chat with no session", () => {
    expect(tabState(tab({ kind: "chat" }))).toBe("open");
  });
});

describe("advanceTabState", () => {
  // Every ordered pair, per kind. The table is the point: a new kind or a
  // fourth state has to be answered for here rather than slipping through.
  const legal = (kind: TabKind, from: TabState, to: TabState) => {
    const states = statesFor(kind);
    return states.includes(from) && states.includes(to) && states.indexOf(to) > states.indexOf(from);
  };

  for (const kind of KINDS) {
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        const want = legal(kind, from, to);
        it(`${kind}: ${from} -> ${to} is ${want ? "allowed" : "refused"}`, () => {
          const t = kind === "chat" ? chat() : tab({ kind });
          seedInert(t.id);
          // Walk to `from` through the legal moves, so the fixture itself only
          // ever uses the door under test.
          for (const step of statesFor(kind)) {
            if (statesFor(kind).indexOf(step) <= statesFor(kind).indexOf(from)) advanceTabState(t, step);
          }
          // A `from` this kind does not have is unreachable, and that is the
          // only reason it may be. Asserted rather than skipped over, or a
          // model that stopped reaching `open` at all would pass every row.
          if (tabState(t) !== from) {
            expect(statesFor(kind), `${kind} cannot reach ${from}`).not.toContain(from);
            return;
          }
          expect(advanceTabState(t, to)).toBe(want);
          expect(tabState(t)).toBe(want ? to : from);
        });
      }
    }
  }

  it("refuses a state the kind does not have, rather than skipping to the next one", () => {
    const t = tab({ kind: "shell" });
    seedInert(t.id);
    expect(advanceTabState(t, "open")).toBe(false);
    expect(tabState(t)).toBe("inert");
  });

  it("refuses standing still, so a repeated call is not a silent success", () => {
    const t = chat();
    seedInert(t.id);
    advanceTabState(t, "open");
    expect(advanceTabState(t, "open")).toBe(false);
  });
});

describe("seedInert", () => {
  it("puts a tab behind its default, which is the only way back", () => {
    const t = tab({ kind: "shell" });
    seedInert(t.id);
    expect(tabState(t)).toBe("inert");
  });

  // The backward move the model exists to prevent. A live tab re-seeded would
  // read as having no process while its PTY kept running.
  it("refuses a tab that already carries a state", () => {
    const t = chat();
    seedInert(t.id);
    advanceTabState(t, "live");
    seedInert(t.id);
    expect(tabState(t)).toBe("live");
  });
});

describe("stateOnActivate", () => {
  it("wakes an inert chat to open, never straight to live", () => {
    const t = chat();
    seedInert(t.id);
    expect(stateOnActivate(t)).toBe("open");
  });

  it("wakes an inert terminal kind straight to live, since it has no middle", () => {
    for (const kind of KINDS.filter((k) => k !== "chat")) {
      const t = tab({ kind, id: `t-${kind}` });
      seedInert(t.id);
      expect(stateOnActivate(t), kind).toBe("live");
    }
  });

  // Clicking a tab twice must not be two steps, and clicking an open draft must
  // not be the thing that spawns it.
  it("leaves anything past inert exactly where it is", () => {
    const draft = tab({ kind: "chat" });
    expect(stateOnActivate(draft)).toBe("open");

    const shell = tab({ kind: "shell", id: "t2" });
    expect(stateOnActivate(shell)).toBe("live");
  });
});

describe("dropTabState", () => {
  // Restore reuses stored tab ids since phase 1, so a record left behind would
  // be inherited by a tab that never asked for it.
  it("leaves nothing for a future tab reusing the id to inherit", () => {
    const t = tab({ kind: "shell" });
    seedInert(t.id);
    dropTabState(t.id);
    expect(tabState(t)).toBe("live");
  });
});

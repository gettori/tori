import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Two separate claims:
//
//   1. the request goes out against a document the server has actually been
//      sent, carrying the diagnostics it published itself;
//   2. what comes back is read in both shapes the spec allows, and nothing the
//      menu cannot run survives normalising.

type Target = {
  root: string;
  serverId?: string;
  ready: Promise<void>;
  supports: (cap: string) => boolean;
  sync: () => void;
  request: (method: string, params: unknown) => Promise<unknown>;
};

let targets: Target[] = [];

vi.mock("./lspClient", () => ({
  lspTargetFor: (path: string) => targets.find((t) => path.startsWith(t.root)) ?? null,
  lspTargets: () => targets,
}));

const {
  requestCodeActions,
  normalizeCodeActions,
  refreshCodeActions,
  requestSourceAction,
  currentCodeActions,
  onCodeActionsChange,
  clearCodeActions,
  groupedCodeActions,
  resolveCodeAction,
  runCodeAction,
  CODE_ACTION_KINDS,
} = await import("./lspCodeActions");
const { clearDiagnosticContext, rememberDiagnostics } = await import("./lspDiagnosticContext");

const at = (line: number, character: number) => ({ line, character });
const range = (sl: number, sc: number, el: number, ec: number) => ({ start: at(sl, sc), end: at(el, ec) });

/** A target recording the order it was asked things in. */
function target(opts: { root?: string; provides?: string[]; res?: unknown; fail?: string; slowReady?: boolean }) {
  const log: string[] = [];
  const asked: { method: string; params: unknown }[] = [];
  let release = () => {};
  const t: Target & { log: string[]; asked: typeof asked; release: () => void } = {
    root: opts.root ?? "/proj",
    serverId: "ts",
    ready: opts.slowReady
      ? new Promise<void>((r) => {
          release = () => {
            log.push("ready");
            r();
          };
        })
      : Promise.resolve(),
    supports: (cap) => {
      log.push(`supports:${cap}`);
      return (opts.provides ?? []).includes(cap);
    },
    sync: () => log.push("sync"),
    request: (method, params) => {
      log.push(`request:${method}`);
      asked.push({ method, params });
      return opts.fail ? Promise.reject(new Error(opts.fail)) : Promise.resolve(opts.res ?? []);
    },
    log,
    asked,
    release: () => release(),
  };
  return t;
}

beforeEach(() => {
  targets = [];
  clearDiagnosticContext();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("requestCodeActions", () => {
  it("flushes the document before asking, so the reply is about what was typed", () => {
    // The library's own sync is debounced by 500 ms. A ⌘⌥A pressed straight
    // after a keystroke lands inside that window, and without this the server
    // answers with positions from before the edit.
    const t = target({ provides: ["codeActionProvider"] });
    targets = [t];

    return requestCodeActions("/proj/a.ts", range(0, 0, 0, 0)).then(() => {
      expect(t.log).toEqual(["supports:codeActionProvider", "sync", "request:textDocument/codeAction"]);
    });
  });

  it("waits for initialize before deciding the server cannot do this", async () => {
    // `supports` is false until initialize is answered. Reading it early would
    // make the first press after opening a project depend on how fast the
    // server started.
    const t = target({ provides: ["codeActionProvider"], slowReady: true });
    targets = [t];

    const pending = requestCodeActions("/proj/a.ts", range(0, 0, 0, 0));
    await Promise.resolve();
    expect(t.log, "nothing asked yet").toEqual([]);

    t.release();
    await pending;
    expect(t.log[0]).toBe("ready");
  });

  it("sends the server its own diagnostics for the range, fields intact", async () => {
    const t = target({ provides: ["codeActionProvider"] });
    targets = [t];
    rememberDiagnostics("file:///proj/a.ts", "ts", [
      { range: range(3, 4, 3, 9), message: "Cannot find name 'foo'.", code: 2304 },
      { range: range(40, 0, 40, 2), message: "elsewhere", code: 2551 },
    ]);

    await requestCodeActions("/proj/a.ts", range(3, 6, 3, 6));

    const params = t.asked[0].params as {
      textDocument: { uri: string };
      range: unknown;
      context: { diagnostics: { code?: number }[]; triggerKind: number };
    };
    expect(params.textDocument.uri).toBe("file:///proj/a.ts");
    expect(params.range).toEqual(range(3, 6, 3, 6));
    expect(params.context.diagnostics.map((d) => d.code), "only the one under the caret").toEqual([2304]);
    expect(params.context.triggerKind, "a person asked").toBe(1);
  });

  it("sends only what its own server published, not another's on the same line", async () => {
    const t = target({ provides: ["codeActionProvider"] });
    targets = [t];
    rememberDiagnostics("file:///proj/a.ts", "ts", [{ range: range(3, 4, 3, 9), message: "type", code: 2304 }]);
    rememberDiagnostics("file:///proj/a.ts", "eslint", [{ range: range(3, 4, 3, 9), message: "lint", code: "no-undef" }]);

    await requestCodeActions("/proj/a.ts", range(3, 6, 3, 6));

    const params = t.asked[0].params as { context: { diagnostics: { message: string }[] } };
    expect(params.context.diagnostics.map((d) => d.message)).toEqual(["type"]);
  });

  it("answers null when no server claims the file", async () => {
    expect(await requestCodeActions("/elsewhere/a.ts", range(0, 0, 0, 0))).toBeNull();
  });

  it("answers null when the server advertises no provider, and asks nothing", async () => {
    const t = target({ provides: [] });
    targets = [t];

    expect(await requestCodeActions("/proj/a.ts", range(0, 0, 0, 0))).toBeNull();
    expect(t.asked, "a request would draw a MethodNotFound").toEqual([]);
  });

  it("answers null rather than throwing when the request fails", async () => {
    targets = [target({ provides: ["codeActionProvider"], fail: "server died" })];
    expect(await requestCodeActions("/proj/a.ts", range(0, 0, 0, 0))).toBeNull();
  });

  it("tells an empty answer apart from no answer at all", async () => {
    // Null hides the surface; empty means the server looked. The gutter reads
    // the difference, so they must not collapse into one value here.
    targets = [target({ provides: ["codeActionProvider"], res: [] })];
    expect(await requestCodeActions("/proj/a.ts", range(0, 0, 0, 0))).toEqual([]);
  });
});

describe("requestSourceAction", () => {
  const whole = range(0, 0, 40, 0);

  it("names the kind it wants, since a server computes a source action only when asked", () => {
    // tsserver does not volunteer organize-imports in an unfiltered answer, so
    // without `only` the command comes back empty against a working server.
    const t = target({ provides: ["codeActionProvider"], res: [{ title: "Organize", kind: "source.organizeImports" }] });
    targets = [t];

    return requestSourceAction("/proj/a.ts", "source.organizeImports", whole).then(() => {
      const params = t.asked[0].params as { context: { only?: string[] } };
      expect(params.context.only).toEqual(["source.organizeImports"]);
    });
  });

  it("hands back the one action the server offered", async () => {
    targets = [target({ provides: ["codeActionProvider"], res: [{ title: "Organize", kind: "source.organizeImports" }] })];

    const action = await requestSourceAction("/proj/a.ts", "source.organizeImports", whole);

    expect(action?.title).toBe("Organize");
  });

  it("takes the first where a server answers with several", async () => {
    // A server ordering its own answers puts the one it means first, and a
    // command named "Organize imports" cannot ask which one was meant.
    targets = [
      target({
        provides: ["codeActionProvider"],
        res: [
          { title: "first", kind: "source.organizeImports" },
          { title: "second", kind: "source.organizeImports" },
        ],
      }),
    ];

    expect((await requestSourceAction("/proj/a.ts", "source.organizeImports", whole))?.title).toBe("first");
  });

  it("refuses an action of a kind it did not ask for", async () => {
    // Servers answer a filtered request with what they think is close enough.
    // An "add missing imports" arriving in answer to "organize imports" would
    // be a different edit running under the command's name.
    targets = [
      target({
        provides: ["codeActionProvider"],
        res: [{ title: "Add all missing imports", kind: "source.addMissingImports" }],
      }),
    ];

    expect(await requestSourceAction("/proj/a.ts", "source.organizeImports", whole)).toBeNull();
  });

  it("accepts a more specific kind beneath the one asked for", async () => {
    targets = [
      target({ provides: ["codeActionProvider"], res: [{ title: "Organize", kind: "source.organizeImports.ts" }] }),
    ];

    expect((await requestSourceAction("/proj/a.ts", "source.organizeImports", whole))?.title).toBe("Organize");
  });

  it("answers null when the server has nothing, rather than throwing", async () => {
    targets = [target({ provides: ["codeActionProvider"], res: [] })];
    expect(await requestSourceAction("/proj/a.ts", "source.organizeImports", whole)).toBeNull();
  });
});

describe("normalizeCodeActions", () => {
  it("reads a code-action literal whole", () => {
    const [a] = normalizeCodeActions([
      {
        title: "Add import",
        kind: "quickfix",
        isPreferred: true,
        edit: { changes: {} },
        data: { id: 7 },
      },
    ]);

    expect(a.title).toBe("Add import");
    expect(a.kind).toBe("quickfix");
    expect(a.isPreferred).toBe(true);
    expect(a.data).toEqual({ id: 7 });
  });

  it("reads a bare Command as an action whose only step is running it", () => {
    // Still permitted by the spec even with literal support declared, and what
    // an older server answers on the same code path.
    const [a] = normalizeCodeActions([
      { title: "Run fix", command: "_typescript.applyFix", arguments: [1, 2] },
    ]);

    expect(a.title).toBe("Run fix");
    expect(a.command).toEqual({ title: "Run fix", command: "_typescript.applyFix", arguments: [1, 2] });
    expect(a.edit, "a Command carries no edit, by definition").toBeUndefined();
  });

  it("keeps an action carrying both an edit and a command", () => {
    // The spec applies the edit and then runs the command; tsserver's "add all
    // missing imports" is this shape, and dropping either half breaks it.
    const [a] = normalizeCodeActions([
      { title: "Fix all", edit: { changes: {} }, command: { title: "then", command: "x" } },
    ]);

    expect(a.edit).toBeTruthy();
    expect(a.command?.command).toBe("x");
  });

  it("drops a disabled action, since Tori never asked to be told about one", () => {
    expect(normalizeCodeActions([{ title: "Nope", disabled: { reason: "not here" } }])).toEqual([]);
  });

  it("drops an entry with nothing to show in a menu", () => {
    expect(normalizeCodeActions([{ kind: "quickfix" }, { title: "" }, null, 7])).toEqual([]);
  });

  it("reads a null answer as no actions", () => {
    expect(normalizeCodeActions(null)).toEqual([]);
  });
});

describe("resolveCodeAction", () => {
  /** A target whose `codeActionProvider` carries whatever the case needs. */
  function resolver(opts: { provider?: unknown; res?: unknown; fail?: string }) {
    const asked: { method: string; params: unknown }[] = [];
    const t: Target & { asked: typeof asked; capability: () => unknown } = {
      root: "/proj",
      ready: Promise.resolve(),
      supports: () => !!opts.provider,
      // What tells "I do code actions" apart from "I resolve them": only the
      // object form of the capability can carry `resolveProvider`.
      capability: () => opts.provider,
      sync: () => {},
      request: (method, params) => {
        asked.push({ method, params });
        return opts.fail ? Promise.reject(new Error(opts.fail)) : Promise.resolve(opts.res);
      },
      asked,
    };
    return t;
  }

  it("fills in the edit a server left out of the list", async () => {
    // The whole point of declaring resolveSupport: tsserver costs a compile per
    // refactor, so a menu that resolved every entry up front never opens.
    const t = resolver({
      provider: { resolveProvider: true },
      res: { title: "Add import", kind: "quickfix", edit: { changes: { "file:///a.ts": [] } } },
    });
    targets = [t];

    const out = await resolveCodeAction("/proj/a.ts", { title: "Add import", data: { id: 1 } });

    expect(out.edit).toBeTruthy();
    expect(t.asked[0].method).toBe("codeAction/resolve");
  });

  it("hands the server back its own object, not a rebuilt one", async () => {
    // The spec's round trip is "return the action you were given, filled in",
    // and a server may read fields off it that mean nothing here.
    const raw = { title: "Add import", data: { id: 1 }, diagnostics: [{ code: 2304 }] };
    const t = resolver({ provider: { resolveProvider: true }, res: raw });
    targets = [t];
    const [action] = normalizeCodeActions([raw]);

    await resolveCodeAction("/proj/a.ts", action);

    expect(t.asked[0].params).toBe(raw);
  });

  it("does not ask a server that never claimed it resolves", async () => {
    // `codeActionProvider: true` says "I do code actions", not "I resolve
    // them"; asking anyway draws a MethodNotFound.
    const t = resolver({ provider: true });
    targets = [t];

    const action = { title: "x", data: { id: 1 } };
    expect(await resolveCodeAction("/proj/a.ts", action)).toBe(action);
    expect(t.asked).toEqual([]);
  });

  it("does not ask for an action that already carries its edit", async () => {
    const t = resolver({ provider: { resolveProvider: true } });
    targets = [t];

    await resolveCodeAction("/proj/a.ts", { title: "x", edit: { changes: {} }, data: { id: 1 } });

    expect(t.asked).toEqual([]);
  });

  it("does not ask for an action carrying no data to resolve from", async () => {
    const t = resolver({ provider: { resolveProvider: true } });
    targets = [t];

    await resolveCodeAction("/proj/a.ts", { title: "x" });

    expect(t.asked).toEqual([]);
  });

  it("hands back what it has when the resolve fails", async () => {
    // An unresolved action still has whatever it arrived with, and one carrying
    // a command needs no edit at all.
    targets = [resolver({ provider: { resolveProvider: true }, fail: "boom" })];
    const action = { title: "x", data: { id: 1 }, command: { command: "c" } };

    expect(await resolveCodeAction("/proj/a.ts", action)).toBe(action);
  });
});

describe("runCodeAction", () => {
  function deps(over: Partial<Parameters<typeof runCodeAction>[2]> = {}) {
    const log: string[] = [];
    return {
      log,
      deps: {
        applyEdit: (_edit: unknown, title: string) => {
          log.push(`apply:${title}`);
          return Promise.resolve(null);
        },
        runCommand: (c: { command: string }) => {
          log.push(`command:${c.command}`);
          return Promise.resolve();
        },
        ...over,
      } as Parameters<typeof runCodeAction>[2],
    };
  }

  beforeEach(() => {
    targets = [target({ provides: ["codeActionProvider"] })];
  });

  it("applies the edit an action arrived with", async () => {
    const d = deps();
    const out = await runCodeAction("/proj/a.ts", { title: "Add import", edit: { changes: {} } }, d.deps);

    expect(out).toEqual({ kind: "done" });
    expect(d.log).toEqual(["apply:Add import"]);
  });

  it("runs a command-only action, which is how it reaches the applyEdit router", async () => {
    // The server answers `workspace/executeCommand` by pushing a
    // `workspace/applyEdit` straight back, which Phase 1's router answers.
    const d = deps();
    const out = await runCodeAction(
      "/proj/a.ts",
      { title: "Organize imports", command: { command: "_typescript.organizeImports" } },
      d.deps,
    );

    expect(out).toEqual({ kind: "done" });
    expect(d.log).toEqual(["command:_typescript.organizeImports"]);
  });

  it("applies the edit before running the command, for an action carrying both", async () => {
    // The spec's order, and not arbitrary: the command is the server's
    // follow-up to changes that have already been made.
    const d = deps();
    await runCodeAction(
      "/proj/a.ts",
      { title: "Fix all", edit: { changes: {} }, command: { command: "after" } },
      d.deps,
    );

    expect(d.log).toEqual(["apply:Fix all", "command:after"]);
  });

  it("stops at a refused edit rather than telling the server it landed", async () => {
    const d = deps({ applyEdit: () => Promise.resolve("a.ts has unsaved changes") });
    const out = await runCodeAction(
      "/proj/a.ts",
      { title: "Fix all", edit: { changes: {} }, command: { command: "after" } },
      d.deps,
    );

    expect(out).toEqual({ kind: "refused", reason: "a.ts has unsaved changes" });
    expect(d.log, "the command never ran").toEqual([]);
  });

  it("reports a command that threw, naming the action", async () => {
    const d = deps({ runCommand: () => Promise.reject(new Error("no such command")) });
    const out = await runCodeAction("/proj/a.ts", { title: "Organize imports", command: { command: "x" } }, d.deps);

    expect(out.kind).toBe("refused");
    expect((out as { reason: string }).reason).toContain("Organize imports");
  });

  it("says so when an action turns out to have nothing to do", async () => {
    const d = deps();
    expect(await runCodeAction("/proj/a.ts", { title: "Empty" }, d.deps)).toEqual({ kind: "nothing" });
    expect(d.log).toEqual([]);
  });
});

describe("refreshCodeActions, the latest-request-wins guard", () => {
  /** A target whose replies are released by hand, so two can be in flight. */
  function slowTarget(root = "/proj") {
    const queue: ((res: unknown) => void)[] = [];
    const t: Target & { queue: typeof queue } = {
      root,
      ready: Promise.resolve(),
      supports: () => true,
      sync: () => {},
      request: () => new Promise((r) => queue.push(r)),
      queue,
    };
    return t;
  }

  const action = (title: string) => ({ title, kind: "quickfix" });
  /** Let both asks get past their `await ready` and reach the transport. */
  const inFlight = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => clearCodeActions());

  it("publishes what the server offered, with the range it was asked about", async () => {
    targets = [target({ provides: ["codeActionProvider"], res: [action("Add import")] })];

    await refreshCodeActions("/proj/a.ts", range(2, 0, 2, 0));

    expect(currentCodeActions()?.path).toBe("/proj/a.ts");
    expect(currentCodeActions()?.range).toEqual(range(2, 0, 2, 0));
    expect(currentCodeActions()?.actions?.map((a) => a.title)).toEqual(["Add import"]);
  });

  it("discards a reply for an older selection that lands after a newer one", async () => {
    // A busy server can answer a refactor query a compile late. Without this,
    // the previous line's fixes end up behind the current caret.
    const t = slowTarget();
    targets = [t];

    const older = refreshCodeActions("/proj/a.ts", range(1, 0, 1, 0));
    const newer = refreshCodeActions("/proj/a.ts", range(9, 0, 9, 0));
    await inFlight();

    t.queue[1]([action("newer")]);
    expect(await newer).toBe(true);
    t.queue[0]([action("older")]);
    expect(await older, "the older ask reports that it lost").toBe(false);

    expect(currentCodeActions()?.range).toEqual(range(9, 0, 9, 0));
    expect(currentCodeActions()?.actions?.map((a) => a.title)).toEqual(["newer"]);
  });

  it("discards a reply the caret has already moved away from", async () => {
    // A caret move does not always re-ask, so the token alone leaves nothing to
    // supersede a reply that is already about the wrong place.
    targets = [target({ provides: ["codeActionProvider"], res: [action("stale")] })];

    const landed = await refreshCodeActions("/proj/a.ts", range(1, 0, 1, 0), () => false);

    expect(landed).toBe(false);
    expect(currentCodeActions(), "nothing was published").toBeNull();
  });

  it("keeps two files' requests apart", async () => {
    // The token is per path: a slow answer for one file must not cancel a fast
    // one for another, which is what a single counter would do.
    const t = slowTarget();
    targets = [t];

    const a = refreshCodeActions("/proj/a.ts", range(0, 0, 0, 0));
    const b = refreshCodeActions("/proj/b.ts", range(0, 0, 0, 0));
    await inFlight();

    t.queue[1]([action("b")]);
    t.queue[0]([action("a")]);

    expect(await b).toBe(true);
    expect(await a, "a's own token was never superseded").toBe(true);
  });

  it("publishes null when there was nothing to ask, which is not an empty menu", async () => {
    targets = [];
    await refreshCodeActions("/elsewhere/a.ts", range(0, 0, 0, 0));
    expect(currentCodeActions()?.actions).toBeNull();
  });

  it("tells its listeners, and stops once they unsubscribe", async () => {
    targets = [target({ provides: ["codeActionProvider"], res: [] })];
    let calls = 0;
    const off = onCodeActionsChange(() => (calls += 1));

    await refreshCodeActions("/proj/a.ts", range(0, 0, 0, 0));
    expect(calls).toBe(1);

    off();
    await refreshCodeActions("/proj/a.ts", range(1, 0, 1, 0));
    expect(calls).toBe(1);
  });

  it("clears the offer, since an action is a promise about a range in a document", async () => {
    targets = [target({ provides: ["codeActionProvider"], res: [action("x")] })];
    await refreshCodeActions("/proj/a.ts", range(0, 0, 0, 0));

    let calls = 0;
    const off = onCodeActionsChange(() => (calls += 1));
    clearCodeActions();

    expect(currentCodeActions()).toBeNull();
    expect(calls, "the surfaces are told to stop drawing it").toBe(1);

    clearCodeActions();
    expect(calls, "clearing nothing wakes nobody").toBe(1);
    off();
  });
});

describe("groupedCodeActions", () => {
  const a = (title: string, kind?: string, isPreferred?: boolean) => ({ title, kind, isPreferred });

  it("puts quick fixes above refactors above source actions", async () => {
    const groups = groupedCodeActions([a("extract", "refactor.extract"), a("organize", "source.organizeImports"), a("import", "quickfix")]);
    expect(groups.map((g) => g.map((x) => x.title))).toEqual([["import"], ["extract"], ["organize"]]);
  });

  it("files an unknown kind with its nearest known ancestor", async () => {
    // The spec's own rule: a kind is dotted and hierarchical, so `refactor.move`
    // is a refactor even though nothing here has heard of it.
    const groups = groupedCodeActions([a("move", "refactor.move"), a("fix", "quickfix")]);
    expect(groups.map((g) => g.map((x) => x.title))).toEqual([["fix"], ["move"]]);
  });

  it("keeps the server's own order inside a group", async () => {
    // It is a ranking, not an accident: re-sorting would put a generic fix
    // above the one tsserver thinks is most likely.
    const [group] = groupedCodeActions([a("second", "quickfix"), a("first", "quickfix")]);
    expect(group.map((x) => x.title)).toEqual(["second", "first"]);
  });

  it("lifts the action the server called preferred to the top of its group", async () => {
    const [group] = groupedCodeActions([a("other", "quickfix"), a("best", "quickfix", true)]);
    expect(group.map((x) => x.title)).toEqual(["best", "other"]);
  });

  it("drops empty groups, so a file with only fixes gets no stray separator", async () => {
    expect(groupedCodeActions([a("fix", "quickfix")])).toHaveLength(1);
    expect(groupedCodeActions([])).toEqual([]);
  });

  it("keeps an action with no kind at all, at the end", async () => {
    // What a bare `Command` normalises to, and dropping it would drop the
    // action rather than tidy the menu.
    const groups = groupedCodeActions([a("bare"), a("fix", "quickfix")]);
    expect(groups.map((g) => g.map((x) => x.title))).toEqual([["fix"], ["bare"]]);
  });
});

describe("the kinds Tori asks for", () => {
  it("covers the two the later phases depend on", () => {
    expect(CODE_ACTION_KINDS).toContain("quickfix");
    expect(CODE_ACTION_KINDS).toContain("source.organizeImports");
  });
});

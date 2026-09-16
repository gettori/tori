import { describe, it, expect } from "vitest";

import {
  anchorFor,
  attachConfig,
  attachFailureMessage,
  attachPortFor,
  configFor,
  DEFAULT_ATTACH_PORT,
  describeTarget,
  fileConfig,
  isPort,
  lastTargetFor,
  loadAttachPorts,
  loadLastTargets,
  parseAttachPorts,
  parseLastTargets,
  scriptConfig,
  setAttachPort,
  setLastTarget,
  type DebugTarget,
  type TargetContext,
} from "./debugTargets";

const ENV = { PATH: "/Users/x/.volta/bin:/usr/bin" };

function ctx(over: Partial<TargetContext> = {}): TargetContext {
  return { root: "/repo", entries: ["package.json"], env: ENV, ...over };
}

describe("a launch config", () => {
  it("runs the active file from the resolved root", () => {
    const config = fileConfig(ctx({ root: "/repo/packages/api" }), "/repo/packages/api/src/x.ts");

    expect(config).toMatchObject({
      type: "pwa-node",
      request: "launch",
      program: "/repo/packages/api/src/x.ts",
      // Not the workspace root. `cwd` decides module resolution for the
      // debuggee *and* where its source maps resolve from, so a package
      // debugged at the workspace root does not merely behave worse, its
      // breakpoints never bind.
      cwd: "/repo/packages/api",
    });
    expect(config.name).toBe("Debug x.ts");
  });

  it("runs a package script with the runner the lockfile names", () => {
    const pnpm = scriptConfig(ctx({ entries: ["package.json", "pnpm-lock.yaml"] }), "test");
    expect(pnpm).toMatchObject({ runtimeExecutable: "pnpm", runtimeArgs: ["run", "test"] });

    // `npm run test` in a pnpm repo is not a preference somebody got wrong, it
    // is a command that installs the wrong tree. The rule is `tasks.ts`'s, not
    // a second copy of it.
    const npm = scriptConfig(ctx({ entries: ["package.json", "package-lock.json"] }), "test");
    expect(npm.runtimeExecutable).toBe("npm");
    expect(scriptConfig(ctx({ entries: ["yarn.lock"] }), "dev").runtimeExecutable).toBe("yarn");
    expect(scriptConfig(ctx({ entries: ["bun.lockb"] }), "dev").runtimeExecutable).toBe("bun");
  });

  it("keeps the debuggee's stdio on the DAP wire", () => {
    // Phase 1 measured the alternative: `integratedTerminal` and
    // `externalTerminal` both make js-debug issue `runInTerminal`, and a client
    // that cannot serve it loses the session at zero stops, zero output and
    // zero errors, completely silently.
    for (const config of [fileConfig(ctx(), "/repo/a.js"), scriptConfig(ctx(), "dev")]) {
      expect(config.console).toBe("internalConsole");
    }
  });

  it("pauses at entry so a source map has time to resolve", () => {
    // Not a user-visible pause: `dapSessions` continues straight through it.
    // Phase 1 proved the TypeScript failure is a race, and that four variants
    // of `outFiles` / `resolveSourceMapLocations` changed nothing.
    for (const config of [fileConfig(ctx(), "/repo/a.ts"), scriptConfig(ctx(), "dev")]) {
      expect(config.stopOnEntry).toBe(true);
    }
  });

  it("carries the login-shell PATH rather than the GUI process's", () => {
    // gotchas#gui-launched-processes-inherit-a-minimal-path: a debuggee that
    // shells out to `pnpm` cannot find it on the PATH a GUI-launched app has.
    expect(fileConfig(ctx(), "/repo/a.js").env).toEqual(ENV);
    expect(scriptConfig(ctx(), "dev").env).toEqual(ENV);
  });
});

describe("an attach config", () => {
  it("carries none of the launch-only fields", () => {
    const config = attachConfig(ctx(), 9229);

    expect(config).toMatchObject({ type: "pwa-node", request: "attach", port: 9229, cwd: "/repo" });
    // `console` is declared on `INodeLaunchConfiguration` and does not exist on
    // `INodeAttachConfiguration`, so sending it is a field with no slot.
    expect("console" in config).toBe(false);
    // Tori did not start this process, so it has no entry to pause at and no
    // environment to hand it.
    expect("stopOnEntry" in config).toBe(false);
    expect("env" in config).toBe(false);
  });

  it("says what to do when nothing is listening", () => {
    const message = attachFailureMessage(9229, new Error("connect ECONNREFUSED"));
    // A bare timeout sends people looking at firewalls. This one names the
    // single common cause.
    expect(message).toContain("--inspect");
    expect(message).toContain("9229");
    expect(message).toContain("connect ECONNREFUSED");
    // And still reads as a sentence with no adapter message to quote.
    expect(attachFailureMessage(9229, null)).toContain("--inspect");
  });
});

describe("choosing a target", () => {
  it("routes each kind to its own config", () => {
    const targets: DebugTarget[] = [
      { kind: "file", path: "/repo/a.ts" },
      { kind: "script", script: "dev" },
      { kind: "attach", port: 5858 },
    ];
    expect(targets.map((t) => configFor(t, ctx()).request)).toEqual(["launch", "launch", "attach"]);
  });

  it("resolves a file target against its own file and the rest against the workspace", () => {
    // A script and an attach have no file, so the root walk has nothing of
    // their own to start from.
    expect(anchorFor({ kind: "file", path: "/repo/pkg/a.ts" }, "/repo")).toBe("/repo/pkg/a.ts");
    expect(anchorFor({ kind: "script", script: "dev" }, "/repo")).toBe("/repo");
    expect(anchorFor({ kind: "attach", port: 9229 }, "/repo")).toBe("/repo");
  });

  it("describes each kind in the words somebody picked it with", () => {
    expect(describeTarget({ kind: "file", path: "/repo/src/index.ts" })).toBe("index.ts");
    expect(describeTarget({ kind: "script", script: "test" })).toBe("run test");
    expect(describeTarget({ kind: "attach", port: 9229 })).toBe("port 9229");
  });
});

describe("the remembered attach port", () => {
  it("offers node's own default until one has been used", () => {
    expect(attachPortFor({}, "/ws")).toBe(DEFAULT_ATTACH_PORT);
    expect(attachPortFor({ "/ws": 5858 }, "/ws")).toBe(5858);
    // Another workspace's port is not this one's.
    expect(attachPortFor({ "/other": 5858 }, "/ws")).toBe(DEFAULT_ATTACH_PORT);
  });

  it("rejects what could not be an inspector port", () => {
    expect(isPort(9229)).toBe(true);
    expect(isPort(1024)).toBe(true);
    expect(isPort(65535)).toBe(true);
    // Nothing runs `node --inspect` in the privileged range, so a number there
    // is a typo rather than a choice.
    expect(isPort(80)).toBe(false);
    expect(isPort(70000)).toBe(false);
    expect(isPort(9229.5)).toBe(false);
    expect(isPort("9229")).toBe(false);
    expect(isPort(null)).toBe(false);
  });

  it("returns the same store on a no-op, and drops a bad port", () => {
    const store = { "/ws": 5858 };
    expect(setAttachPort(store, "/ws", 5858)).toBe(store);
    expect(setAttachPort(store, "/ws", 80)).toBe(store);
    expect(setAttachPort(store, "/ws", 9229)).toEqual({ "/ws": 9229 });
  });

  it("keeps the well-formed entries beside a hand-edited one", () => {
    expect(parseAttachPorts(JSON.stringify({ "/ws": 5858 }))).toEqual({ "/ws": 5858 });
    expect(parseAttachPorts(JSON.stringify({ "/ws": "nope", "/b": 5000 }))).toEqual({ "/b": 5000 });
    expect(parseAttachPorts("{not json")).toEqual({});
    expect(parseAttachPorts("[]")).toEqual({});
    expect(parseAttachPorts(null)).toEqual({});
  });

  it("survives storage being unavailable", () => {
    // Node has no localStorage, so this is the "quota or private mode" path.
    expect(loadAttachPorts()).toEqual({});
  });
});

describe("the last target", () => {
  it("is what F5 repeats, per workspace", () => {
    const store = setLastTarget({}, "/ws", { kind: "script", script: "test" });
    expect(lastTargetFor(store, "/ws")).toEqual({ kind: "script", script: "test" });
    expect(lastTargetFor(store, "/other")).toBeNull();
  });

  it("refuses a shape this build does not know", () => {
    expect(parseLastTargets(JSON.stringify({ "/ws": { kind: "file", path: "/ws/a.ts" } }))).toEqual({
      "/ws": { kind: "file", path: "/ws/a.ts" },
    });

    // Read back across releases: a target written by a build that knew a fourth
    // kind must be ignored rather than launched as something it is not, and so
    // must one whose port is no longer acceptable.
    expect(
      parseLastTargets(
        JSON.stringify({
          "/a": { kind: "browser", url: "http://x" },
          "/b": { kind: "attach", port: 80 },
          "/c": { kind: "file", path: "" },
          "/d": { kind: "attach", port: 9229 },
        }),
      ),
    ).toEqual({ "/d": { kind: "attach", port: 9229 } });
    expect(parseLastTargets("{not json")).toEqual({});
  });

  it("survives storage being unavailable", () => {
    expect(loadLastTargets()).toEqual({});
  });
});

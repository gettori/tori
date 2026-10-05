import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";

// The impure half: what `launchTarget` asks the backend for, and what it does
// with a target the adapter refuses. `debugTargets.ts` owns the config rules and
// is tested on its own; nothing here re-asserts them.

type Handle = { server: string; session: string };
type Invoke = { cmd: string; args: Record<string, unknown> };

const calls: Invoke[] = [];
const channels = new Map<string, { onmessage: ((m: string) => void) | null }>();
let sessionCounter = 0;
let resolvedRoot = "/repo/packages/api";
let entries = ["package.json", "pnpm-lock.yaml"];
let packageJson = JSON.stringify({ scripts: { dev: "vite", test: "vitest" } });
/** Commands the fake adapter refuses, so a real failure path can be driven. */
const failCommands = new Set<string>();
/** What `dap_cargo_build` answers. */
let cargoBuild: () => Promise<unknown> = () => Promise.resolve({ executable: "/x", sysroot: null });

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args: args ?? {} });
    switch (cmd) {
      case "dap_registry":
        return Promise.resolve([
          { id: "js-debug", label: "JavaScript", languages: { ts: "pwa-node" }, childSessions: true },
          { id: "lldb", label: "Rust, C and C++", languages: { rs: "lldb-dap" }, childSessions: false },
        ]);
      case "dap_cargo_build":
        return cargoBuild();
      case "dap_root_for":
        return Promise.resolve(resolvedRoot);
      case "dap_launch_env":
        return Promise.resolve({ PATH: "/Users/x/.volta/bin:/usr/bin" });
      case "fs_read_dir":
        return Promise.resolve(entries.map((name) => ({ name })));
      case "fs_read_file":
        return Promise.resolve(packageJson);
      case "dap_start": {
        const handle: Handle = { server: "dap0", session: `sess${sessionCounter++}` };
        channels.set(handle.session, args!.onMessage as { onmessage: ((m: string) => void) | null });
        return Promise.resolve(handle);
      }
      case "dap_send": {
        const handle = args!.handle as Handle;
        const frame = JSON.parse(args!.message as string) as Record<string, unknown>;
        if (frame.type === "request") {
          const failed = failCommands.has(frame.command as string);
          void Promise.resolve().then(() =>
            channels.get(handle.session)?.onmessage?.(
              JSON.stringify({
                seq: 9000,
                type: "response",
                request_seq: frame.seq,
                command: frame.command,
                success: !failed,
                ...(failed ? { message: "connect ECONNREFUSED 127.0.0.1:9229" } : {}),
                body: {},
              }),
            ),
          );
        }
        return Promise.resolve();
      }
      default:
        return Promise.resolve(null);
    }
  },
  Channel: class {
    onmessage: ((m: string) => void) | null = null;
  },
}));

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function freshModule() {
  vi.resetModules();
  return import("./debugLaunch");
}

/** The config that reached the wire. The session map is private, so this is the
 *  only route to what was actually launched. */
function launched(): Record<string, unknown> | null {
  const send = calls.find((c) => {
    if (c.cmd !== "dap_send") return false;
    const frame = JSON.parse(c.args.message as string) as { command?: string };
    return frame.command === "launch" || frame.command === "attach";
  });
  if (!send) return null;
  return (JSON.parse(send.args.message as string) as { arguments: Record<string, unknown> }).arguments;
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  calls.length = 0;
  channels.clear();
  sessionCounter = 0;
  resolvedRoot = "/repo/packages/api";
  entries = ["package.json", "pnpm-lock.yaml"];
  packageJson = JSON.stringify({ scripts: { dev: "vite", test: "vitest" } });
  failCommands.clear();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
});

describe("what a launch is built from", () => {
  it("takes cwd from the backend's root, never the workspace root", async () => {
    const m = await freshModule();
    await m.launchTarget(
      { adapterId: "js-debug", kind: "file", path: "/repo/packages/api/src/x.ts" },
      { projectPath: "/repo", onError: () => {} },
    );
    await flush();

    // The one field that decides whether a monorepo package's breakpoints bind
    // at all, and the reason `root_for` stayed a single implementation.
    expect(launched()).toMatchObject({ cwd: "/repo/packages/api" });
    const asked = calls.find((c) => c.cmd === "dap_root_for");
    expect(asked?.args).toMatchObject({ filePath: "/repo/packages/api/src/x.ts", projectPath: "/repo" });
  });

  it("reads the lockfile at the resolved root, not at the project root", async () => {
    const m = await freshModule();
    await m.launchTarget(
      { adapterId: "js-debug", kind: "script", script: "dev" },
      { projectPath: "/repo", onError: () => {} },
    );
    await flush();

    // The package's own lockfile is the one that decides its runner.
    expect(calls.find((c) => c.cmd === "fs_read_dir")?.args.path).toBe("/repo/packages/api");
    expect(launched()).toMatchObject({ runtimeExecutable: "pnpm", runtimeArgs: ["run", "dev"] });
  });
});

describe("the scripts offered", () => {
  it("are the resolved root's, in declaration order", async () => {
    const m = await freshModule();
    expect(await m.scriptsAt("/repo/packages/api")).toEqual(["dev", "test"]);
  });

  it("are empty for a root with no package.json", async () => {
    const m = await freshModule();
    entries = ["Cargo.toml"];
    expect(await m.scriptsAt("/repo/crates/x")).toEqual([]);
  });

  it("survive a package.json that will not parse", async () => {
    const m = await freshModule();
    packageJson = "{not json";
    expect(await m.scriptsAt("/repo/packages/api")).toEqual([]);
  });
});

describe("a Cargo target", () => {
  it("shows the first build error and starts no adapter", async () => {
    const m = await freshModule();
    cargoBuild = () => Promise.reject("error[E0308]: mismatched types --> src/main.rs:2:18");
    const errors: string[] = [];

    await m.launchTarget(
      { adapterId: "lldb", kind: "cargo", dir: "/repo/crates/app", bin: "app" },
      { projectPath: "/repo", onError: (e) => errors.push(e) },
    );
    await flush();

    expect(errors).toEqual(["Could not build app: error[E0308]: mismatched types --> src/main.rs:2:18"]);
    expect(calls.some((c) => c.cmd === "dap_start")).toBe(false);
  });
});

describe("when the adapter refuses", () => {
  it("says --inspect for an attach rather than passing the timeout through", async () => {
    const m = await freshModule();
    failCommands.add("attach");
    const errors: string[] = [];

    await m.launchTarget(
      { adapterId: "js-debug", kind: "attach", port: 9229 },
      { projectPath: "/repo", onError: (e) => errors.push(e) },
    );
    await flush();

    // A refused connection to an inspector port has one common cause and the
    // adapter's own message does not name it; a bare timeout sends people
    // looking at firewalls.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("--inspect");
    expect(errors[0]).toContain("9229");
    expect(errors[0]).toContain("ECONNREFUSED");
  });

  it("passes a launch failure through, since it is already specific", async () => {
    const m = await freshModule();
    failCommands.add("launch");
    const errors: string[] = [];

    await m.launchTarget(
      { adapterId: "js-debug", kind: "file", path: "/repo/gone.ts" },
      { projectPath: "/repo", onError: (e) => errors.push(e) },
    );
    await flush();

    expect(errors).toHaveLength(1);
    // A missing file or a script that does not exist names itself; dressing it
    // up as an attach hint would be worse than the adapter's own words.
    expect(errors[0]).not.toContain("--inspect");
    expect(errors[0]).toContain("ECONNREFUSED");
  });
});

import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { onWith, TOAST, type ToastEvent } from "../../../../utils/events";
import { render, screen, waitFor, cleanup, fireEvent } from "../../../../test/harness";
import type { DapHealth } from "./DapSection";

let save: (next: unknown) => Promise<unknown> = async (next) => next;
let health: DapHealth[] = [];
let calls: [string, unknown][] = [];
let askedForErrors = false;
let reply: (() => Promise<unknown>) | null = null;
const lspError = { kind: "lsp", file: "/cfg/packs/lsp/typescript.toml", message: "bundled id", fix: null };

type Handler = (e: { payload: unknown }) => void;
let handlers: { name: string; fn: Handler }[] = [];
const emit = (name: string, payload: unknown) =>
  handlers.filter((h) => h.name === name).forEach((h) => h.fn({ payload }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, fn: Handler) => {
    const entry = { name, fn };
    handlers.push(entry);
    return Promise.resolve(() => (handlers = handlers.filter((h) => h !== entry)));
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => {
    calls.push([cmd, args]);
    if (cmd === "set_settings") return save((args as { settings: unknown }).settings);
    if (cmd === "dap_health" && reply) return reply();
    if (cmd !== "packs_load_errors") return Promise.resolve(cmd === "dap_health" ? health : null);
    askedForErrors = true;
    return Promise.resolve([lspError]);
  },
}));

const { default: DapSection } = await import("./DapSection");

const delve = (over: Partial<DapHealth> = {}): DapHealth => ({
  id: "delve",
  label: "Go (Delve)",
  program: "dlv",
  status: "versionUnknown",
  path: "/Users/me/go/bin/dlv",
  version: null,
  adapterVersion: null,
  verifiedAgainst: "dlv 1.27.2",
  verifiedOn: "2026-10-09",
  verified: "stated",
  description: null,
  contributor: null,
  license: null,
  extensions: ["go"],
  detail: null,
  disabled: false,
  availableVersion: null,
  installedVersion: null,
  hint: null,
  update: null,
  uninstall: null,
  provenance: { source: "bundled", updateAvailable: false, catalogConflict: false },
  ...over,
});

beforeEach(() => {
  save = async (next) => next;
  cleanup();
  health = [];
  calls = [];
  reply = null;
});

describe("DapSection", () => {
  it("offers Update pack and Remove pack on a catalog debugger", async () => {
    health = [delve({ provenance: { source: "catalog", updateAvailable: true, catalogConflict: false } })];
    render(() => <DapSection />);

    fireEvent.click(await waitFor(() => screen.getByLabelText("Update the Go (Delve) pack")));
    await waitFor(() => expect(calls).toContainEqual(["packs_update", { kind: "dap", id: "delve" }]));
    const remove = () => screen.getByLabelText("Remove the Go (Delve) pack") as HTMLButtonElement;
    await waitFor(() => expect(remove().disabled).toBe(false));
    fireEvent.click(remove());
    await waitFor(() => expect(calls).toContainEqual(["packs_remove", { kind: "dap", id: "delve" }]));
  });

  it("says a version the adapter cannot report is stated, not checked", async () => {
    health = [delve()];
    render(() => <DapSection />);

    await waitFor(() => expect(screen.getByText(/stated, not checked/)).toBeTruthy());
    expect(screen.getByText(/dlv 1\.27\.2/)).toBeTruthy();
  });

  it("keeps the neutral line when the pack states no version either", async () => {
    health = [delve({ verifiedAgainst: null, verifiedOn: null, verified: null })];
    render(() => <DapSection />);

    await waitFor(() => expect(screen.getByText(/so Tori cannot check it/)).toBeTruthy());
    expect(screen.queryByText(/stated, not checked/)).toBeNull();
  });

  it("leaves another kind's load error to its own pane", async () => {
    health = [delve()];
    render(() => <DapSection />);

    await waitFor(() => expect(screen.getByText("Go (Delve)")).toBeTruthy());
    await waitFor(() => expect(askedForErrors).toBe(true));
    await Promise.resolve();
    expect(screen.queryByText("Needs fixing")).toBeNull();
    expect(screen.queryByText(lspError.file)).toBeNull();
  });
});

describe("the debuggers health read", () => {
  function hold() {
    let resolve!: (value: unknown) => void;
    const promise = new Promise((yes) => (resolve = yes));
    return { promise, resolve };
  }
  const asked = () => calls.filter(([cmd]) => cmd === "dap_health").length;

  it("says it is checking until the answer lands", async () => {
    const first = hold();
    reply = () => first.promise;
    render(() => <DapSection />);
    expect(await screen.findByText("Checking which debuggers are installed...")).toBeTruthy();

    first.resolve([delve()]);
    expect(await screen.findByText("Go (Delve)")).toBeTruthy();
    expect(screen.queryByText("Checking which debuggers are installed...")).toBeNull();
  });

  it("keeps the cards while a pack change asks again", async () => {
    health = [delve()];
    render(() => <DapSection />);
    await screen.findByText("Go (Delve)");

    const second = hold();
    reply = () => second.promise;
    emit("packs:changed", "dap");
    await waitFor(() => expect(asked()).toBe(2));
    expect(screen.getByText("Go (Delve)")).toBeTruthy();
    expect(screen.queryByText("Checking which debuggers are installed...")).toBeNull();

    second.resolve([...[delve()], { ...delve(), id: "mine", label: "Mine" }]);
    expect(await screen.findByText("Mine")).toBeTruthy();
  });

  it("says the check failed instead of listing nothing, and tries again", async () => {
    reply = () => Promise.reject("probe died");
    render(() => <DapSection />);
    expect(await screen.findByText(/Could not check debuggers: probe died/)).toBeTruthy();

    reply = null;
    health = [delve()];
    fireEvent.click(screen.getByText("Try again"));
    expect(await screen.findByText("Go (Delve)")).toBeTruthy();
  });
});

describe("the debugger card's Use switch", () => {
  const sw = () => screen.getByRole("switch", { name: "Use Go (Delve)" });
  const toasts: string[] = [];
  onWith<ToastEvent>(TOAST, (t) => toasts.push(t.message));

  for (const ok of [true, false]) {
    it(`shows the switch off at once, then ${ok ? "keeps it off once saved" : "turns it back on when the save fails"}`, async () => {
      health = [delve()];
      let answer!: (ok: boolean) => void;
      save = (next) => new Promise((yes, no) => (answer = (fine) => (fine ? yes(next) : no("disk full"))));
      render(() => <DapSection />);
      await waitFor(() => expect(sw().getAttribute("aria-checked")).toBe("true"));

      fireEvent.click(sw());
      await waitFor(() => expect(sw().getAttribute("aria-checked")).toBe("false"));

      answer(ok);
      await waitFor(() => expect(sw().getAttribute("aria-checked")).toBe(ok ? "false" : "true"));
      if (!ok) await waitFor(() => expect(toasts).toContain("Could not turn off Go (Delve): disk full"));
    });
  }
});

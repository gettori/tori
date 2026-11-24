import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor, cleanup, fireEvent } from "../../../../test/harness";

let calls: [string, unknown][] = [];
let reply: (() => Promise<unknown>) | null = null;

const gofmt = {
  id: "gofmt",
  label: "gofmt",
  program: "gofmt",
  status: "versionUnknown",
  version: null,
  verifiedAgainst: null,
  verifiedOn: null,
  description: null,
  contributor: null,
  license: null,
  extensions: ["go"],
  markers: [],
  runsPerProject: false,
  disabled: false,
  provenance: { source: "catalog", updateAvailable: true, catalogConflict: false },
};

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
    if (cmd === "formatter_health" && reply) return reply();
    return Promise.resolve(cmd === "formatter_health" ? [gofmt] : null);
  },
}));

const { default: FormattersSection } = await import("./FormattersSection");

beforeEach(() => {
  cleanup();
  calls = [];
});

describe("FormattersSection", () => {
  it("offers Update pack and Remove pack on a catalog formatter", async () => {
    render(() => <FormattersSection />);

    fireEvent.click(await waitFor(() => screen.getByLabelText("Update the gofmt pack")));
    await waitFor(() => expect(calls).toContainEqual(["packs_update", { kind: "formatters", id: "gofmt" }]));
    const remove = () => screen.getByLabelText("Remove the gofmt pack") as HTMLButtonElement;
    await waitFor(() => expect(remove().disabled).toBe(false));
    fireEvent.click(remove());
    await waitFor(() => expect(calls).toContainEqual(["packs_remove", { kind: "formatters", id: "gofmt" }]));
  });
});

describe("the formatters health read", () => {
  function hold() {
    let resolve!: (value: unknown) => void;
    const promise = new Promise((yes) => (resolve = yes));
    return { promise, resolve };
  }
  const asked = () => calls.filter(([cmd]) => cmd === "formatter_health").length;

  it("says it is checking until the answer lands", async () => {
    const first = hold();
    reply = () => first.promise;
    render(() => <FormattersSection />);
    expect(await screen.findByText("Checking which formatters are installed...")).toBeTruthy();

    first.resolve([gofmt]);
    expect(await screen.findAllByText("gofmt")).not.toHaveLength(0);
    expect(screen.queryByText("Checking which formatters are installed...")).toBeNull();
  });

  it("keeps the cards while a pack change asks again", async () => {
    render(() => <FormattersSection />);
    await screen.findAllByText("gofmt");

    const second = hold();
    reply = () => second.promise;
    emit("packs:changed", "formatters");
    await waitFor(() => expect(asked()).toBe(2));
    expect(screen.getAllByText("gofmt")).not.toHaveLength(0);
    expect(screen.queryByText("Checking which formatters are installed...")).toBeNull();

    second.resolve([...[gofmt], { ...gofmt, id: "mine", label: "Mine" }]);
    expect(await screen.findByText("Mine")).toBeTruthy();
  });

  it("says the check failed instead of listing nothing, and tries again", async () => {
    reply = () => Promise.reject("probe died");
    render(() => <FormattersSection />);
    expect(await screen.findByText(/Could not check formatters: probe died/)).toBeTruthy();

    reply = null;

    fireEvent.click(screen.getByText("Try again"));
    expect(await screen.findAllByText("gofmt")).not.toHaveLength(0);
  });
});

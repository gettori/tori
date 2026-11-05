import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor, cleanup, fireEvent } from "@solidjs/testing-library";

let calls: [string, unknown][] = [];

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

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => {
    calls.push([cmd, args]);
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

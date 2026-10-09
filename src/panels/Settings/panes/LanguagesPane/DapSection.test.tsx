import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor, cleanup } from "@solidjs/testing-library";
import type { DapHealth } from "./DapSection";

let health: DapHealth[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => Promise.resolve(cmd === "dap_health" ? health : null),
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
  ...over,
});

beforeEach(() => {
  cleanup();
  health = [];
});

describe("DapSection", () => {
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
});

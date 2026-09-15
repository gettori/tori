import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@solidjs/testing-library";
import { OPEN_JOB, onWith, type OpenJob } from "../../../../utils/events";
import type { GitReport } from "../../../../utils/gitHealth";

const toolsMissing: GitReport = {
  health: { kind: "toolsMissing" },
  install: { type: "terminal", program: "/usr/bin/xcode-select", args: ["--install"] },
};
const ready: GitReport = {
  health: { kind: "ready", path: "/usr/bin/git", version: "2.54.0" },
  install: { type: "undeclared" },
};

let answer: GitReport = toolsMissing;
let refreshes = 0;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "refresh_git_health") refreshes += 1;
    return Promise.resolve(answer);
  },
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: () => Promise.resolve("/Users/me") }));

import GitSection from "./GitSection";

beforeEach(() => {
  cleanup();
  answer = toolsMissing;
  refreshes = 0;
});

describe("the Git settings section", () => {
  it("opens the tools installer and re-probes when the window regains focus", async () => {
    const jobs: OpenJob[] = [];
    const off = onWith<OpenJob>(OPEN_JOB, (j) => jobs.push(j));
    render(() => <GitSection />);

    fireEvent.click(await screen.findByText("Install Command Line Tools"));
    await waitFor(() => expect(jobs.map((j) => j.program)).toEqual(["/usr/bin/xcode-select"]));
    expect(await screen.findByText(/installer opened/)).toBeTruthy();

    answer = ready;
    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByText("Ready")).toBeTruthy();
    expect(refreshes).toBe(1);
    off();
  });

  it("flips the pill on a manual check", async () => {
    render(() => <GitSection />);
    expect(await screen.findByText("Not installed")).toBeTruthy();

    answer = ready;
    fireEvent.click(screen.getByText("Check again"));
    expect(await screen.findByText("Ready")).toBeTruthy();
  });
});

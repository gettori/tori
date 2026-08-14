// What "ready" means, and the two ways getting it wrong hurts.
//
// A wrong yes costs one clear spawn failure. A wrong no makes a working harness
// unreachable with nothing on screen saying why, so every unknown case leans
// toward yes.
//
// The store is a module singleton with a once-only fetch, so these run in one
// sequence against one sweep rather than re-seeding it per test.
import { describe, it, expect, vi, beforeAll } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { agentReady, agentHealth, ensureAgentHealthLoaded, type AgentHealth } from "./agentHealth";

const row = (id: string, status: AgentHealth["status"]): AgentHealth => ({
  id,
  label: id,
  program: id,
  status,
  path: null,
  version: null,
  verifiedAgainst: null,
  sessionsDir: null,
  sessionsDirExists: false,
  hooks: false,
  needsYou: false,
  overridePath: null,
});

describe("agentReady before the sweep lands", () => {
  it("says yes, so a slow probe never empties the picker", () => {
    expect(agentHealth()).toBeNull();
    expect(agentReady("claude")).toBe(true);
  });
});

describe("agentReady once the sweep has landed", () => {
  beforeAll(async () => {
    invoke.mockResolvedValue([
      row("matched", "versionMatch"),
      row("unknown-version", "versionUnknown"),
      row("drifted", "versionDrift"),
      row("missing", "notFound"),
    ]);
    ensureAgentHealthLoaded();
    await vi.waitFor(() => expect(agentHealth()).not.toBeNull());
  });

  it("hides only the harness whose binary does not resolve", () => {
    expect(agentReady("missing")).toBe(false);
    expect(agentReady("matched")).toBe(true);
  });

  // Drift means Sway has not measured this version, not that it is broken, so
  // it stays startable and says so elsewhere.
  it("keeps a drifted harness available", () => {
    expect(agentReady("drifted")).toBe(true);
  });

  // An adapter carrying no `verified_against` says nothing about the install.
  it("keeps a harness with an unparseable version available", () => {
    expect(agentReady("unknown-version")).toBe(true);
  });

  // An adapter the sweep did not cover is ignorance, not a verdict.
  it("keeps an adapter with no health row available", () => {
    expect(agentReady("never-swept")).toBe(true);
  });
});

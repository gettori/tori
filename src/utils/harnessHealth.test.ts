// What "ready" means, and the two ways getting it wrong hurts.
//
// A wrong yes costs one clear spawn failure. A wrong no makes a working agent
// unreachable with nothing on screen saying why, so every unknown case leans
// toward yes.
//
// The store is a module singleton with a once-only fetch, so these run in one
// sequence against one sweep rather than re-seeding it per test.
import { describe, it, expect, vi, beforeAll } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  agentReady,
  agentHealth,
  asTabProfile,
  profileSignedOut,
  ensureAgentHealthLoaded,
  type AgentHealth,
} from "./agentHealth";

const row = (
  id: string,
  status: AgentHealth["status"],
  signIn: AgentHealth["signIn"] = "unknown",
): AgentHealth => ({
  id,
  label: id,
  program: id,
  status,
  signIn,
  account: null,
  apiKeySource: null,
  path: null,
  version: null,
  verifiedAgainst: null,
  sessionsDir: null,
  sessionsDirExists: false,
  hooks: false,
  needsYou: false,
  overridePath: null,
  profiles: [],
});

/** The same row, plus per-account answers, which is what two signed-in
 *  profiles of one agent look like to the sweep. */
const withProfiles = (
  id: string,
  signIn: AgentHealth["signIn"],
  profiles: Record<string, AgentHealth["signIn"]>,
): AgentHealth => ({
  ...row(id, "versionMatch", signIn),
  profiles: Object.entries(profiles).map(([pid, s]) => ({
    id: pid,
    label: pid,
    signIn: s,
    account: null,
    apiKeySource: null,
  })),
});

// The backend has two vocabularies for one account: a session row is tagged
// with the id of the root that held its transcript (a real id, so the literal
// "default"), while a tab spells the same account null. One crossing, so no
// later comparison has to know that one account has two names.
describe("the tab model's spelling of an account", () => {
  it("folds the index's default-account id onto null, and leaves the rest alone", () => {
    expect(asTabProfile("default")).toBeNull();
    expect(asTabProfile(null)).toBeNull();
    expect(asTabProfile(undefined)).toBeNull();
    // An empty string is not an account either, and would otherwise ride
    // through to a spawn as an id nothing resolves.
    expect(asTabProfile("")).toBeNull();
    expect(asTabProfile("fonn")).toBe("fonn");
  });
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
      row("signed-out", "versionMatch", "signedOut"),
      row("signed-in", "versionMatch", "signedIn"),
      withProfiles("split", "signedOut", { default: "signedOut", fonn: "signedIn" }),
      withProfiles("split-other-way", "signedIn", { default: "signedIn", fonn: "signedOut" }),
    ]);
    ensureAgentHealthLoaded();
    await vi.waitFor(() => expect(agentHealth()).not.toBeNull());
  });

  it("hides only the agent whose binary does not resolve", () => {
    expect(agentReady("missing")).toBe(false);
    expect(agentReady("matched")).toBe(true);
  });

  // Drift means Sway has not measured this version, not that it is broken, so
  // it stays startable and says so elsewhere.
  it("keeps a drifted agent available", () => {
    expect(agentReady("drifted")).toBe(true);
  });

  // An adapter carrying no `verified_against` says nothing about the install.
  it("keeps a agent with an unparseable version available", () => {
    expect(agentReady("unknown-version")).toBe(true);
  });

  // An adapter the sweep did not cover is ignorance, not a verdict.
  it("keeps an adapter with no health row available", () => {
    expect(agentReady("never-swept")).toBe(true);
  });

  // Installed and signed in are two facts. This one is the agent's own answer
  // about itself, not a Sway inference, and starting the session anyway would
  // produce a tab asking for a login the chat surface cannot give.
  it("hides an installed agent nobody is signed in to", () => {
    expect(agentReady("signed-out")).toBe(false);
    expect(agentReady("signed-in")).toBe(true);
  });

  // The default for every adapter that cannot answer, and for every probe that
  // did not finish. It must not read as signed out.
  it("keeps a agent whose sign-in state is unknown available", () => {
    expect(agentReady("matched")).toBe(true);
  });

  // The gate is per account, in both directions. A draft on the signed-in
  // account must not be refused because the other login expired, and a draft
  // on the expired one must not be let through because the other is fine.
  it("answers per account, not per agent", () => {
    expect(agentReady("split", "fonn")).toBe(true);
    expect(agentReady("split", null)).toBe(false);

    expect(agentReady("split-other-way", "fonn")).toBe(false);
    expect(agentReady("split-other-way", null)).toBe(true);
  });

  it("falls back to the agent's own answer for an account the sweep has no row for", () => {
    expect(profileSignedOut("signed-out", "added-since")).toBe(true);
    expect(profileSignedOut("signed-in", "added-since")).toBe(false);
  });
});

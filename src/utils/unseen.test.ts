import { describe, it, expect } from "vitest";
import { reconcileScan, markViewed, isUnseen, stampKey, type Stamps } from "./unseen";

const s = (id: string, cwd: string, last_active: number, agent = "claude") => ({ id, agent, cwd, last_active });

describe("reconcileScan", () => {
  it("stamps a first-sight session so its pre-stamp activity never badges", () => {
    const out = reconcileScan({}, "/w/a", [s("1", "/w/a", 100)], 500);
    expect(out[stampKey("claude", "1")].at).toBe(500);
    expect(isUnseen(out, s("1", "/w/a", 100), null)).toBe(false);
  });

  it("stamps at the session's own activity when that is ahead of now (clock skew)", () => {
    const out = reconcileScan({}, "/w/a", [s("1", "/w/a", 900)], 500);
    expect(out[stampKey("claude", "1")].at).toBe(900);
    expect(isUnseen(out, s("1", "/w/a", 900), null)).toBe(false);
  });

  it("leaves an existing stamp's timestamp alone", () => {
    const before: Stamps = { "claude:1": { at: 100, cwd: "/w/a" } };
    const out = reconcileScan(before, "/w/a", [s("1", "/w/a", 300)], 500);
    expect(out[stampKey("claude", "1")].at).toBe(100);
    expect(isUnseen(out, s("1", "/w/a", 300), null)).toBe(true);
  });

  it("prunes a vanished session inside the scanned folder", () => {
    const before: Stamps = { "claude:1": { at: 100, cwd: "/w/a/sub" } };
    const out = reconcileScan(before, "/w/a", [], 500);
    expect(out).toEqual({});
  });

  it("never prunes a stamp from a folder this scan did not cover", () => {
    const before: Stamps = { "claude:1": { at: 100, cwd: "/w/b" } };
    const out = reconcileScan(before, "/w/a", [], 500);
    expect(out).toEqual(before);
  });

  it("keys per agent, so same-id sessions from two adapters do not collide", () => {
    const out = reconcileScan({}, "/w/a", [s("1", "/w/a", 10), s("1", "/w/a", 10, "pi")], 500);
    expect(Object.keys(out).sort()).toEqual(["claude:1", "pi:1"]);
  });

  it("follows a session whose cwd moved, without resetting its stamp", () => {
    const before: Stamps = { "claude:1": { at: 100, cwd: "/w/a" } };
    const out = reconcileScan(before, "/w/a2", [s("1", "/w/a2", 300)], 500);
    expect(out["claude:1"]).toEqual({ at: 100, cwd: "/w/a2" });
  });
});

describe("isUnseen", () => {
  const stamps: Stamps = { "claude:1": { at: 200, cwd: "/w/a" } };

  it("badges activity newer than the stamp", () => {
    expect(isUnseen(stamps, s("1", "/w/a", 300), null)).toBe(true);
  });

  it("never badges the selected row", () => {
    expect(isUnseen(stamps, s("1", "/w/a", 300), "1")).toBe(false);
  });

  it("does not badge a session with no stamp yet", () => {
    expect(isUnseen(stamps, s("2", "/w/a", 999), null)).toBe(false);
  });

  it("clears once the session is marked viewed", () => {
    const after = markViewed(stamps, s("1", "/w/a", 300), 400);
    expect(isUnseen(after, s("1", "/w/a", 300), null)).toBe(false);
  });
});

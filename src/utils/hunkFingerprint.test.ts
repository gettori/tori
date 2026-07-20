import { describe, it, expect } from "vitest";
import { hunkFingerprint } from "./hunkFingerprint";

describe("hunkFingerprint", () => {
  it("matches the Rust implementation", () => {
    // Locked to the value src-tauri/src/patch.rs asserts for the same input.
    // A drift here means the backend refuses every stage, so both suites pin it.
    expect(hunkFingerprint("@@ -1,1 +1,1 @@", ["-a", "+b"])).toBe("8fb2ba78");
  });

  it("is stable across calls", () => {
    const a = hunkFingerprint("@@ -1,3 +1,4 @@", [" one", "+added", " two"]);
    const b = hunkFingerprint("@@ -1,3 +1,4 @@", [" one", "+added", " two"]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it("changes when the body changes by one character", () => {
    const base = hunkFingerprint("@@ -1,1 +1,1 @@", ["-a", "+b"]);
    expect(hunkFingerprint("@@ -1,1 +1,1 @@", ["-a", "+c"])).not.toBe(base);
  });

  it("changes when the header changes", () => {
    const base = hunkFingerprint("@@ -1,1 +1,1 @@", ["-a", "+b"]);
    expect(hunkFingerprint("@@ -9,1 +9,1 @@", ["-a", "+b"])).not.toBe(base);
  });

  it("does not collide on line-boundary ambiguity", () => {
    // ["ab"] and ["a","b"] must differ: the separator is part of the hash, or
    // two different hunks could share a fingerprint.
    expect(hunkFingerprint("@@", ["ab"])).not.toBe(hunkFingerprint("@@", ["a", "b"]));
  });
});

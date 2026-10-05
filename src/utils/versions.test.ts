// The one comparison the app makes with versions, and its stance: ahead of
// the measurement is silence, behind it is the only warnable state, and
// ignorance never warns.
import { describe, it, expect } from "vite-plus/test";
import { behindVerified, verifiedVersion } from "./versions";

describe("behindVerified", () => {
  it("is true when the installed binary is older than the measured one", () => {
    expect(behindVerified("0.82.1", "pi 0.83.0")).toBe(true);
    // A shorter version compares with missing segments as zero.
    expect(behindVerified("1.2", "x 1.2.1")).toBe(true);
  });

  it("is false when ahead: vendors ship weekly, so this is the steady state", () => {
    expect(behindVerified("2.1.233", "claude 2.1.231")).toBe(false);
  });

  it("is false on an exact match", () => {
    expect(behindVerified("2.1.231", "claude 2.1.231")).toBe(false);
  });

  it("never warns out of ignorance", () => {
    expect(behindVerified(null, "claude 2.1.231")).toBe(false);
    expect(behindVerified("2.1.231", null)).toBe(false);
    expect(behindVerified("nightly", "claude 2.1.231")).toBe(false);
    expect(behindVerified("2.1.231", "untagged build")).toBe(false);
  });

  it("compares numerically, not lexically", () => {
    // The string "9" sorts after "10"; the number does not.
    expect(behindVerified("0.9.0", "x 0.10.0")).toBe(true);
  });
});

describe("verifiedVersion", () => {
  it("extracts the version half of a program-and-version string", () => {
    expect(verifiedVersion("claude 2.1.231")).toBe("2.1.231");
    expect(verifiedVersion("0.83.0")).toBe("0.83.0");
    expect(verifiedVersion(null)).toBeNull();
    expect(verifiedVersion("unversioned")).toBeNull();
  });
});

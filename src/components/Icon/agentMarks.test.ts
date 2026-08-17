// Which agents wear a real logo, pinned against the bundled adapters Sway
// actually ships.
//
// The point is not the count. It is that **a mark is a claim about who ran the
// turn**, so this file's job is to catch the two ways that claim goes wrong: a
// logo quietly disappearing because a key was renamed, and a logo appearing on
// an agent it does not belong to.
import { describe, it, expect } from "vitest";
import { FALLBACK_ADAPTERS } from "../../utils/agents";
import { agentMark, knownMarks } from "./agentMarks";

describe("the marks the bundled adapters name", () => {
  it("resolves every adapter's declared icon", () => {
    for (const a of FALLBACK_ADAPTERS) {
      expect(!!agentMark(a.icon), `${a.id} (icon: ${a.icon})`).toBe(true);
    }
  });

  // The other direction: a mark nothing declares is artwork with no caller,
  // which is how a renamed icon key would hide. One key per adapter, no more.
  it("carries no mark that no adapter declares", () => {
    const declared = new Set(FALLBACK_ADAPTERS.map((a) => a.icon));
    for (const key of knownMarks()) {
      expect(declared.has(key), `${key} is a mark no adapter names`).toBe(true);
    }
  });

  it("never invents a mark for a name nothing registered", () => {
    expect(agentMark("stakpak")).toBeUndefined();
    expect(agentMark(undefined)).toBeUndefined();
    expect(agentMark("")).toBeUndefined();
  });
});

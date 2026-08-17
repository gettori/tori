// Which agents wear a real logo, pinned against the two lists that decide it:
// the bundled adapters and the ACP catalogue Sway actually ships.
//
// The point is not the count. It is that **a mark is a claim about who ran the
// turn**, so this file's job is to catch the two ways that claim goes wrong: a
// logo quietly disappearing because a key was renamed, and a logo appearing on
// an agent it does not belong to.
import { describe, it, expect } from "vitest";
import catalog from "../../../src-tauri/catalog/acp-agents.json";
import { FALLBACK_ADAPTERS } from "../../utils/agents";
import { agentMark } from "./agentMarks";

type Row = { id: string; label: string };
const rows = (Array.isArray(catalog) ? catalog : Object.values(catalog).find(Array.isArray)) as Row[];

describe("the marks the bundled adapters name", () => {
  it("resolves every adapter that declares an icon", () => {
    for (const a of FALLBACK_ADAPTERS) {
      expect(!!agentMark(a.icon), `${a.id} (icon: ${a.icon})`).toBe(true);
    }
  });
});

describe("the marks the ACP catalogue rows resolve", () => {
  // Named rather than counted, so adding a logo is a visible edit here and
  // losing one fails instead of quietly dropping out of a number.
  const EXPECTED = [
    "claude-acp",
    "cline",
    "codex-acp",
    "cursor",
    "gemini",
    "github-copilot",
    "github-copilot-cli",
    "junie",
    "kimi",
    "mistral-vibe",
    "opencode",
    "pi-acp",
    "qwen-code",
  ];

  it("gives a mark to exactly the rows we have one for", () => {
    const got = rows.filter((r) => agentMark(r.id)).map((r) => r.id);
    expect(got.sort()).toEqual([...EXPECTED].sort());
  });

  // The three name collisions that a sweep over Simple Icons would "fix" into
  // wrong logos. Each names a real published slug belonging to somebody else.
  it("leaves the near-miss brands bare rather than wearing another company's logo", () => {
    for (const id of ["amp-acp", "grok-build", "goose"]) {
      expect(agentMark(id), `${id} must not resolve`).toBeUndefined();
    }
  });

  it("never invents a mark for an id nothing published", () => {
    expect(agentMark("stakpak")).toBeUndefined();
    expect(agentMark(undefined)).toBeUndefined();
    expect(agentMark("")).toBeUndefined();
  });
});

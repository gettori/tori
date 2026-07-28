import { describe, expect, it } from "vitest";
import { ruleLabel, ruleOriginNote, type ScopedRule } from "./chatRules";

const rule = (over: Partial<ScopedRule> = {}): ScopedRule => ({
  tool: "Read",
  prefix: null,
  glob: null,
  kind: "allow",
  origin: "manual",
  scope: "session",
  ...over,
});

describe("ruleLabel", () => {
  it("names an allow rule by its tool alone, which is what the list has always been", () => {
    expect(ruleLabel(rule())).toBe("Read · anything");
    expect(ruleLabel(rule({ prefix: "/proj/src/" }))).toBe("Read · /proj/src/");
  });

  // A restriction that reads the same as a grant is worse than no label: the
  // one row in the list that means "never" would look like the rows that mean
  // "always".
  it("leads with the kind for a restriction, so it cannot be mistaken for a grant", () => {
    expect(ruleLabel(rule({ tool: "Write", kind: "deny", prefix: "/proj/" }))).toBe("deny Write · /proj/");
    expect(ruleLabel(rule({ tool: "Write", kind: "ask", prefix: "/proj/" }))).toBe("ask Write · /proj/");
  });

  // The glob is what decides where a restriction bites, so showing the prefix
  // instead would name a scope the rule does not actually have.
  it("shows the glob in preference to the prefix when a rule carries one", () => {
    expect(ruleLabel(rule({ tool: "Write", kind: "ask", glob: "**/migrations/**", prefix: "/proj/" }))).toBe(
      "ask Write · **/migrations/**",
    );
  });
});

describe("ruleOriginNote", () => {
  it("explains a learned rule, since nobody remembers writing one", () => {
    expect(ruleOriginNote(rule({ origin: "learned" }))).toMatch(/approved this a few times/i);
  });

  it("says nothing about a rule the user wrote, which needs no explaining", () => {
    expect(ruleOriginNote(rule())).toBeNull();
  });
});

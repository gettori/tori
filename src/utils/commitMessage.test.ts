import { describe, expect, it } from "vite-plus/test";
import { amendRewritesPushed } from "./commitMessage";

describe("amendRewritesPushed", () => {
  it("warns when HEAD is contained in the upstream", () => {
    expect(amendRewritesPushed({ ahead: 0, behind: 0, has_upstream: true, gone: false, sets_upstream: false })).toBe(true);
  });

  it("stays quiet when there are unpushed commits on top", () => {
    expect(amendRewritesPushed({ ahead: 2, behind: 0, has_upstream: true, gone: false, sets_upstream: false })).toBe(false);
  });

  it("stays quiet without an upstream: nothing to rewrite for anyone else", () => {
    expect(amendRewritesPushed({ ahead: 0, behind: 0, has_upstream: false, gone: false, sets_upstream: false })).toBe(false);
  });

  it("stays quiet when the state is unknown", () => {
    expect(amendRewritesPushed(null)).toBe(false);
  });

  it("warns even when behind, since being behind says nothing about HEAD", () => {
    expect(amendRewritesPushed({ ahead: 0, behind: 3, has_upstream: true, gone: false, sets_upstream: false })).toBe(true);
  });
});

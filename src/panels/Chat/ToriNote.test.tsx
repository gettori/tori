import { describe, expect, it } from "vitest";
import { toriNote } from "../../utils/toriNote";
import { toriLabel } from "./ToriNote";

const wake = (body: string) => [{ type: "text" as const, text: `<tori kind="pr_watch">\n${body}\n</tori>` }];

describe("a pull request watch's wake", () => {
  it("draws as a Tori row naming the pull request", () => {
    const note = toriNote(wake("pull request https://github.com/o/r/pull/42:\n- now conflicts with its base\nThis is news, not a decision to merge."));
    expect(note?.kind).toBe("pr_watch");
    expect(toriLabel(note!, () => null)).toBe("Tori: news on pull request #42");
  });

  it("names no single pull request when the wake carries several", () => {
    const note = toriNote(wake("pull request https://github.com/o/r/pull/1:\n- the checks passed\n\npull request https://github.com/o/r/pull/2:\n- watch ended: merged"));
    expect(toriLabel(note!, () => null)).toBe("Tori: news on the pull requests you watch");
  });
});

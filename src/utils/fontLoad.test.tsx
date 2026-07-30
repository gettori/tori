import { describe, expect, it, vi, afterEach } from "vitest";
import { ensureFontLoaded, primaryFamily } from "./fontLoad";

/** Install a fake FontFaceSet, since jsdom ships none. Returns the specs the
 *  code asked for, in order, plus a way to resolve the pending loads. */
function fakeFonts(behaviour: "resolve" | "hang" | "reject" = "resolve") {
  const asked: string[] = [];
  const load = vi.fn((spec: string) => {
    asked.push(spec);
    if (behaviour === "hang") return new Promise(() => {});
    if (behaviour === "reject") return Promise.reject(new Error("no such face"));
    return Promise.resolve([]);
  });
  Object.defineProperty(document, "fonts", { value: { load }, configurable: true });
  return asked;
}

afterEach(() => {
  Reflect.deleteProperty(document, "fonts");
  vi.useRealTimers();
});

describe("primaryFamily", () => {
  it("takes the first family and drops its quotes", () => {
    expect(primaryFamily('"JetBrainsMono Nerd Font Mono", "SF Mono", monospace')).toBe(
      "JetBrainsMono Nerd Font Mono",
    );
    expect(primaryFamily("Menlo, monospace")).toBe("Menlo");
    expect(primaryFamily("")).toBe("");
  });
});

describe("ensureFontLoaded", () => {
  it("asks for the face the grid will be measured from, and for bold alongside", async () => {
    const asked = fakeFonts();
    await ensureFontLoaded('"JetBrainsMono Nerd Font Mono", monospace', 15);
    // Quoted, because the family has spaces and the spec is parsed as CSS.
    expect(asked).toContain('15px "JetBrainsMono Nerd Font Mono"');
    expect(asked).toContain('700 15px "JetBrainsMono Nerd Font Mono"');
  });

  // The measurement matters more than the font: a face that never resolves must
  // not leave a tab with no terminal in it.
  it("gives up waiting rather than blocking the terminal forever", async () => {
    vi.useFakeTimers();
    fakeFonts("hang");
    let done = false;
    const wait = ensureFontLoaded("Ghost Font", 15).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(1999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await wait;
    expect(done).toBe(true);
  });

  it("resolves when the platform has no FontFaceSet at all", async () => {
    // The pre-webfont behaviour, which was fine: measure what is there.
    await expect(ensureFontLoaded("Menlo, monospace", 15)).resolves.toBeUndefined();
  });

  it("resolves when the family does not exist", async () => {
    fakeFonts("reject");
    await expect(ensureFontLoaded("Nonexistent Mono", 15)).resolves.toBeUndefined();
  });
});

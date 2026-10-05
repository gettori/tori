// The quit pipeline's one rule: everyone gets asked, and the first no ends it.
import { describe, it, expect, beforeEach } from "vite-plus/test";
import { closeAllowed, registerCloseGuard } from "./closeGuard";

let offs: (() => void)[] = [];
function guard(answer: boolean | Promise<boolean>, log?: string[], name = "") {
  const off = registerCloseGuard(() => (log?.push(name), answer));
  offs.push(off);
  return off;
}

beforeEach(() => {
  for (const off of offs) off();
  offs = [];
});

describe("close guards", () => {
  it("allows the quit when nobody objects", async () => {
    expect(await closeAllowed()).toBe(true);
    guard(true);
    expect(await closeAllowed()).toBe(true);
  });

  it("stops at the first refusal", async () => {
    // Serial and short-circuiting, because these open modals: a refused quit
    // must not go on to ask about unsaved buffers it is no longer closing.
    const asked: string[] = [];
    guard(false, asked, "quit");
    guard(true, asked, "buffers");

    expect(await closeAllowed()).toBe(false);
    expect(asked).toEqual(["quit"]);
  });

  it("waits for an answer that arrives late", async () => {
    guard(new Promise<boolean>((r) => setTimeout(() => r(false), 5)));
    expect(await closeAllowed()).toBe(false);
  });

  it("forgets an unregistered guard", async () => {
    const off = guard(false);
    off();
    expect(await closeAllowed()).toBe(true);
  });
});

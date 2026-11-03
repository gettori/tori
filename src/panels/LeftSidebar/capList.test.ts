import { describe, expect, it } from "vite-plus/test";
import { capList } from "./capList";

describe("capList", () => {
  const nine = [1, 2, 3, 4, 5, 6, 7, 8, 9];

  it("shows the first six and hides the rest in order", () => {
    expect(capList(nine, 6, () => false)).toEqual({ shown: [1, 2, 3, 4, 5, 6], hidden: [7, 8, 9] });
  });

  it("keeps an item past the cap in its own place", () => {
    expect(capList(nine, 6, (n) => n === 8)).toEqual({ shown: [1, 2, 3, 4, 5, 6, 8], hidden: [7, 9] });
  });
});

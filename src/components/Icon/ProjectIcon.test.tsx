import { describe, expect, it, vi } from "vitest";
import { render } from "@solidjs/testing-library";
import ProjectIcon, { type ProjectIconSource } from "./ProjectIcon";

// The asset protocol is the app's route to a local file; here it only has to be
// identifiable, so the test asserts on the path that reached it.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
}));

/** What the row actually shows: an image (and from where), or a glyph (which). */
function shown(src: ProjectIconSource): { img?: string; glyph?: string } {
  const { container, unmount } = render(() => <ProjectIcon {...src} />);
  const img = container.querySelector("img")?.getAttribute("src") ?? undefined;
  // lucide-solid tags each glyph with a `lucide-<kebab-name>` class alongside
  // the generic `lucide-icon`; the named one is the only stable way to tell one
  // rendered icon from another.
  const glyph = container
    .querySelector("svg")
    ?.getAttribute("class")
    ?.split(/\s+/)
    .find((c) => c.startsWith("lucide-") && c !== "lucide-icon");
  unmount();
  return { img, glyph };
}

describe("ProjectIcon", () => {
  const seed = "/Users/me/Projects/personal/sway";

  it("prefers an uploaded image over everything else", () => {
    const { img } = shown({
      seed,
      iconFile: "/store/sway-abc.png",
      icon: "Rocket",
      favicon: "/p/public/favicon.svg",
    });
    expect(img).toBe("asset:///store/sway-abc.png");
  });

  it("prefers a chosen glyph over the project's own favicon", () => {
    const { img, glyph } = shown({ seed, icon: "Rocket", favicon: "/p/public/favicon.svg" });
    expect(img).toBeUndefined();
    expect(glyph).toBe("lucide-rocket");
  });

  it("falls back to the favicon when nothing was chosen", () => {
    const { img } = shown({ seed, favicon: "/p/public/favicon.svg" });
    expect(img).toBe("asset:///p/public/favicon.svg");
  });

  it("falls through a stored name the registry no longer knows", () => {
    // An icon dropped from the set (or a hand-edited typo) must not blank the
    // row: it resolves to nothing and the next source down takes over.
    const { img } = shown({ seed, icon: "NotAnIcon", favicon: "/p/favicon.ico" });
    expect(img).toBe("asset:///p/favicon.ico");
    expect(shown({ seed, icon: "NotAnIcon" }).glyph).toBeDefined();
  });

  it("shows a stable derived glyph when there is nothing at all", () => {
    const first = shown({ seed });
    expect(first.img).toBeUndefined();
    expect(first.glyph).toBeDefined();
    expect(shown({ seed }).glyph).toBe(first.glyph);
    // A different project is (very likely) a different glyph, and certainly its
    // own stable one.
    const other = shown({ seed: "/Users/me/Projects/work/api" });
    expect(shown({ seed: "/Users/me/Projects/work/api" }).glyph).toBe(other.glyph);
  });
});

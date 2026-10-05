import { describe, it, expect } from "vite-plus/test";
import { render, screen } from "@solidjs/testing-library";
import MemberChip from "./MemberChip";
import { expectNoAxeViolations } from "../../test/axe";

const FE = { seed: "/repos/frontend", icon: "Globe" };
const NS = { seed: "/repos/notification-service" };

describe("MemberChip", () => {
  it("draws the project icon, the derived glyph when none was picked, and no initials", () => {
    const { container } = render(() => (
      <>
        <MemberChip icon={FE} />
        <MemberChip icon={NS} />
      </>
    ));
    expect(container.querySelectorAll("svg")).toHaveLength(2);
    expect(container.textContent).toBe("");
  });

  it("paints the hue alone, or the hue and rgb together", () => {
    const { container } = render(() => (
      <>
        <MemberChip icon={FE} tint="oklch(0.7 0.1 250)" data-testid="one" />
        <MemberChip
          icon={NS}
          chipStyle={{ "--chip-hue": "oklch(0.6 0.2 30)", "--chip-rgb": "220 80 40" }}
          data-testid="two"
        />
      </>
    ));
    const [one, two] = [screen.getByTestId("one"), screen.getByTestId("two")];
    expect(one.style.getPropertyValue("--chip-hue")).toBe("oklch(0.7 0.1 250)");
    expect(two.style.getPropertyValue("--chip-rgb")).toBe("220 80 40");
    // Two members, two different tints: the whole point of the chip.
    expect(one.style.getPropertyValue("--chip-hue")).not.toBe(two.style.getPropertyValue("--chip-hue"));
    expect(container).toBeTruthy();
  });

  it("is announced by default and hidden only when asked", () => {
    render(() => (
      <>
        <MemberChip icon={FE} data-testid="said" />
        <MemberChip icon={NS} decorative data-testid="hidden" />
      </>
    ));
    expect(screen.getByTestId("said").getAttribute("aria-hidden")).toBeNull();
    expect(screen.getByTestId("hidden").getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps a state badge announced inside an undecorated chip", () => {
    render(() => (
      <MemberChip icon={FE} tint="oklch(0.7 0.1 250)">
        <span role="img" aria-label="Worktree missing" />
      </MemberChip>
    ));
    expect(screen.getByRole("img", { name: "Worktree missing" })).toBeTruthy();
  });

  it("passes axe as a plain chip, a decorative one and one carrying a badge", async () => {
    const { container } = render(() => (
      <>
        <MemberChip icon={FE} tint="oklch(0.7 0.1 250)" />
        <MemberChip icon={NS} decorative />
        <MemberChip icon={FE}>
          <span role="img" aria-label="Failed" />
        </MemberChip>
      </>
    ));
    await expectNoAxeViolations(container);
  });
});

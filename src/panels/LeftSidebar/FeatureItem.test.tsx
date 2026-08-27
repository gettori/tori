import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import FeatureItem, { CHIP_CAP, type SpaceTint } from "./FeatureItem";
import type { Feature, Member, MemberState } from "../../utils/features";
import styles from "./FeatureItem.module.css";
import chipStyles from "../../components/MemberChip/MemberChip.module.css";

const SPACES: SpaceTint[] = [
  {
    name: "work",
    color: "Sky",
    projects: [{ path: "/w/api" }, { path: "/w/web" }],
  },
  { name: "Other", projects: [{ path: "/o/dotfiles" }] },
];

function member(repoPath: string, order: number, state: MemberState = { kind: "present" }): Member {
  return {
    repoPath,
    displayName: repoPath.split("/").pop()!,
    worktreePath: null,
    state,
    order,
  };
}

function feature(members: Member[]): Feature {
  return {
    id: "f-1",
    name: "Auth flow",
    branch: "feat/auth-flow",
    members,
    createdAt: 1,
  };
}

const mount = (f: Feature, onRetry = () => {}) =>
  render(() => (
    <ul>
      <FeatureItem feature={f} spaces={SPACES} onRetry={onRetry} />
    </ul>
  ));

describe("FeatureItem", () => {
  it("caps the chip row at six and counts the rest", () => {
    const members = Array.from({ length: 9 }, (_, i) => member(`/w/repo-${i}`, i));
    const { container } = mount(feature(members));
    expect(container.querySelectorAll("[data-chip]").length).toBe(CHIP_CAP);
    expect(screen.getByText("+3")).toBeTruthy();
    const name = container.querySelector("[data-name]")!;
    expect(name.textContent).toBe("Auth flow");
    expect(name.className).toBe(styles.name);
  });

  it("tints a chip by its Space and leaves a repo outside every Space neutral", () => {
    const { container } = mount(feature([member("/w/api", 0), member("/tmp/scratch", 1)]));
    const [inSpace, outside] = Array.from(container.querySelectorAll<HTMLElement>("[data-chip]"));
    expect(inSpace.style.getPropertyValue("--chip-hue")).not.toBe("");
    expect(outside.style.getPropertyValue("--chip-hue")).toBe("");
    // The neutral fallback moved into MemberChip with the chip box itself.
    expect(outside.className).toContain(chipStyles.neutral);
  });

  it("badges a failed member with the reason and offers Retry for it only", async () => {
    const onRetry = vi.fn();
    const failed = member("/w/web", 1, {
      kind: "failed",
      reason: "refusing to overwrite",
    });
    const { container } = mount(
      feature([member("/w/api", 0), failed, member("/o/dotfiles", 2, { kind: "failed", reason: "pending" })]),
      onRetry,
    );
    const badge = screen.getByRole("img", { name: "Failed" });
    expect(badge.getAttribute("title")).toBe("refusing to overwrite");
    expect(screen.getByRole("img", { name: "Creating" })).toBeTruthy();
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Retry web"]);
    fireEvent.click(buttons[0]);
    expect(onRetry).toHaveBeenCalledWith(failed);
    await expectNoAxeViolations(container);
  });
});

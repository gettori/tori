import { describe, it, expect } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import { pointerClick } from "../../test/menus";
import { expectNoAxeViolations } from "../../test/axe";
import MemberChipRow from "./MemberChipRow";
import type { TintedMember } from "../../utils/topicMembers";

const member = (name: string, i: number, broken = false): TintedMember =>
  ({
    member: {
      repoPath: `/repos/${name}`,
      displayName: name,
      worktreePath: broken ? null : `/feat/${name}`,
      state: broken ? { kind: "worktree-missing" } : { kind: "present" },
      order: i,
    },
    key: broken ? `/repos/${name}` : `/feat/${name}`,
    root: broken ? null : `/feat/${name}`,
    label: name,
    state: broken
      ? { label: "Worktree missing", usable: false, action: "recreate", reason: null }
      : { label: "Ready", usable: true, action: null, reason: null },
    hue: undefined,
    style: undefined,
    spaceName: "work",
    projectName: name,
    icon: { seed: `/repos/${name}` },
    kind: "worktree",
  }) as TintedMember;

const NAMES = ["api", "web", "docs", "infra", "mobile", "cli", "sdk", "analytics"];
const eight = () => NAMES.map((n, i) => member(n, i));
const chip = (name: string) => document.querySelector<HTMLElement>(`[data-member="/repos/${name}"]`);
const chips = () => [...document.querySelectorAll("[data-member]")];

describe("the member chip row", () => {
  it("draws every member when there are few enough", () => {
    render(() => <MemberChipRow members={eight().slice(0, 3)} activeRoot="/feat/web" />);
    expect(chips()).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /more members/ })).toBeNull();
  });

  it("marks the member the pane is about", () => {
    render(() => <MemberChipRow members={eight().slice(0, 3)} activeRoot="/feat/web" />);
    expect(chip("web")!.getAttribute("aria-pressed")).toBe("true");
    expect(chip("api")!.getAttribute("aria-pressed")).toBe("false");
  });

  it("caps the row and puts the rest behind +N", () => {
    render(() => <MemberChipRow members={eight()} activeRoot="/feat/api" />);
    expect(chips()).toHaveLength(6);
    expect(screen.getByRole("button", { name: "2 more members" })).toBeTruthy();
  });

  it("gives the active member the last slot rather than hiding it", () => {
    // A row that cannot show which member the pane is about has no reason to
    // exist, so the eighth member displaces the sixth instead of overflowing.
    render(() => <MemberChipRow members={eight()} activeRoot="/feat/analytics" />);
    expect(chips()).toHaveLength(6);
    expect(chip("analytics")!.getAttribute("aria-pressed")).toBe("true");
    expect(chip("cli")).toBeNull();
  });

  it("hands back the folder a chip names", () => {
    const moved: string[] = [];
    render(() => (
      <MemberChipRow members={eight().slice(0, 3)} activeRoot="/feat/api" onActiveRoot={(r) => moved.push(r)} />
    ));
    pointerClick(chip("docs")!);
    expect(moved).toEqual(["/feat/docs"]);
  });

  it("switches from the overflow menu too", async () => {
    const moved: string[] = [];
    render(() => <MemberChipRow members={eight()} activeRoot="/feat/api" onActiveRoot={(r) => moved.push(r)} />);
    pointerClick(screen.getByRole("button", { name: "2 more members" }));
    await screen.findByRole("menu");
    pointerClick(screen.getByRole("menuitem", { name: "analytics" }));
    expect(moved).toEqual(["/feat/analytics"]);
  });

  it("wears a broken member's state and refuses to switch to it", () => {
    const moved: string[] = [];
    render(() => (
      <MemberChipRow
        members={[member("api", 0), member("web", 1, true)]}
        activeRoot="/feat/api"
        onActiveRoot={(r) => moved.push(r)}
      />
    ));
    const broken = chip("web") as HTMLButtonElement;
    expect(broken.disabled).toBe(true);
    expect(broken.getAttribute("aria-label")).toBe("web: Worktree missing");
    pointerClick(broken);
    expect(moved).toEqual([]);
  });
});

describe("the member chip row, to axe", () => {
  it("has no accessibility violations over the cap", () => {
    const { container } = render(() => <MemberChipRow members={eight()} activeRoot="/feat/analytics" />);

    return expectNoAxeViolations(container);
  });
});

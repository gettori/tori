import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import TopicItem, { CHIP_CAP, type SpaceTint } from "./TopicItem";
import type { Topic, Member, MemberState } from "../../utils/topics";
import styles from "./TopicItem.module.css";
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

function topic(members: Member[]): Topic {
  return {
    id: "f-1",
    name: "Auth flow",
    branch: "feat/auth-flow",
    members,
    createdAt: 1,
  };
}

const mount = (f: Topic, onRepair = () => {}, extra: Record<string, unknown> = {}) =>
  render(() => (
    <ul>
      <TopicItem topic={f} spaces={SPACES} onRepair={onRepair} {...extra} />
    </ul>
  ));

const expand = async () => fireEvent.click(await screen.findByRole("button", { name: /^Show members/ }));
const memberRows = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("li[data-member]"));

describe("TopicItem", () => {
  it("caps the chip row at six and counts the rest", () => {
    const members = Array.from({ length: 9 }, (_, i) => member(`/w/repo-${i}`, i));
    const { container } = mount(topic(members));
    expect(container.querySelectorAll("[data-chip]").length).toBe(CHIP_CAP);
    expect(screen.getByText("+3")).toBeTruthy();
    const name = container.querySelector("[data-name]")!;
    expect(name.textContent).toBe("Auth flow");
    expect(name.className).toBe(styles.name);
  });

  it("tints a chip by its Space and leaves a repo outside every Space neutral", () => {
    const { container } = mount(topic([member("/w/api", 0), member("/tmp/scratch", 1)]));
    const [inSpace, outside] = Array.from(container.querySelectorAll<HTMLElement>("[data-chip]"));
    expect(inSpace.style.getPropertyValue("--chip-hue")).not.toBe("");
    expect(outside.style.getPropertyValue("--chip-hue")).toBe("");
    // The neutral fallback moved into MemberChip with the chip box itself.
    expect(outside.className).toContain(chipStyles.neutral);
  });

  // The repair moved onto the member row (#159 phase 3). It was an actions strip
  // under the chips, which named the member in the button and still left the
  // seventh one, hidden behind the `+N`, with nothing to press.
  it("badges a failed member with the reason and offers Retry for it only", async () => {
    const onRepair = vi.fn();
    const failed = member("/w/web", 1, {
      kind: "failed",
      reason: "refusing to overwrite",
    });
    const { container } = mount(
      topic([member("/w/api", 0), failed, member("/o/dotfiles", 2, { kind: "failed", reason: "pending" })]),
      onRepair,
    );
    const badge = screen.getByRole("img", { name: "Failed" });
    expect(badge.getAttribute("title")).toBe("refusing to overwrite");
    expect(screen.getByRole("img", { name: "Creating" })).toBeTruthy();

    await expand();

    // By name, not every button on the row: the disclosure is one too. Pending
    // carries no action, so a member mid-creation offers nothing to press.
    const buttons = screen.getAllByRole("button", { name: /^Retry/ });
    expect(buttons.map((b) => b.textContent)).toEqual(["Retry web"]);
    fireEvent.click(buttons[0]);
    expect(onRepair).toHaveBeenCalledWith(failed, "retry");
    await expectNoAxeViolations(container);
  });

  it("names the repair after the state, one per broken member", async () => {
    const onRepair = vi.fn();
    const gone = member("/w/web", 1, { kind: "worktree-missing" });
    const moved = member("/o/dotfiles", 2, { kind: "repo-missing" });
    mount(topic([member("/w/api", 0), gone, moved]), onRepair);

    await expand();

    expect(screen.getAllByRole("button", { name: /^(Recreate|Locate|Retry)/ }).map((b) => b.textContent)).toEqual([
      "Recreate web",
      "Locate dotfiles",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Recreate web" }));
    expect(onRepair).toHaveBeenCalledWith(gone, "recreate");
    fireEvent.click(screen.getByRole("button", { name: "Locate dotfiles" }));
    expect(onRepair).toHaveBeenCalledWith(moved, "locate");
  });

  describe("the member list", () => {
    const seven = () => topic(Array.from({ length: 7 }, (_, i) => member(`/w/repo-${i}`, i)));

    it("opens one row per member, uncapped, and puts the chip row away", async () => {
      const { container } = mount(seven());
      expect(container.querySelectorAll("[data-chip]").length).toBe(CHIP_CAP);

      await expand();

      // Seven rows where the chip row could only ever show six: a member behind
      // the `+N` is a member whose rename, reorder and repair have no home.
      expect(memberRows(container).length).toBe(7);
      expect(container.querySelector("[data-more]")).toBeNull();
      expect(memberRows(container).map((r) => r.getAttribute("data-member"))).toEqual(
        Array.from({ length: 7 }, (_, i) => `/w/repo-${i}`),
      );
    });

    it("names each member and says what state it is in", async () => {
      const { container } = mount(
        topic([member("/w/api", 0), member("/w/web", 1, { kind: "worktree-missing" })]),
      );
      await expand();

      const rows = memberRows(container);
      expect(rows.map((r) => r.textContent)).toEqual(["apiReady", "webWorktree missingRecreate web"]);
      expect(rows[1].getAttribute("data-state")).toBe("worktree-missing");
    });

    it("carries a row menu and stays clean under axe with it open", async () => {
      const memberMenu = (m: Member) => [
        { label: "Rename…", onClick: () => {} },
        { label: "Move up", disabled: m.order === 0, onClick: () => {} },
      ];
      const { container } = mount(topic([member("/w/api", 0), member("/w/web", 1)]), () => {}, {
        memberMenu,
      });
      await expand();

      fireEvent.contextMenu(memberRows(container)[1]);
      await screen.findByText("Move up");
      await expectNoAxeViolations(container);
    });

    it("drags a row onto the one above it and commits that order", async () => {
      const onReorder = vi.fn();
      const { container } = mount(
        topic([member("/w/api", 0), member("/w/web", 1), member("/o/dotfiles", 2)]),
        () => {},
        { onReorder },
      );
      await expand();

      const [api, web] = memberRows(container);
      fireEvent.dragStart(web);
      fireEvent.dragOver(api);
      fireEvent.drop(api);

      expect(onReorder).toHaveBeenCalledWith(["/w/web", "/w/api", "/o/dotfiles"]);
    });
  });
});

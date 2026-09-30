import { describe, it, expect, vi } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import TopicItem, { CHIP_CAP, type SpaceTint } from "./TopicItem";
import type { Topic, Member, MemberState } from "../../utils/topics";
import type { BranchSync } from "../../utils/gitActions";
import type { Rollup } from "../../utils/sessionStatus";
import styles from "./TopicItem.module.css";
import chipStyles from "../../components/MemberChip/MemberChip.module.css";
import { TabMemberChip } from "../../components/MemberChip/MemberChip";
import { tintedMember } from "../../utils/topicMembers";

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

/** `BranchSync` as the backend sends it, clean unless told otherwise. */
const branchSync = (over: Partial<BranchSync> = {}): BranchSync => ({
  detached: false,
  dirty: false,
  head_committed_at: 1_700_000_000,
  upstream: { ahead: 0, behind: 0, has_upstream: true, gone: false, rewritten: false, superseded: false },
  base: null,
  ...over,
});

const CONFLICTED = branchSync({
  base: { name: "main", ahead: 2, behind: 4, conflicts: ["src/a.ts", "src/b.ts"] },
});

describe("what a Topic row says about its members' branches", () => {
  const withSync = (by: Record<string, BranchSync>) => ({
    memberSync: (m: Member) => by[m.repoPath] ?? null,
  });

  it("reports the loudest member, and names it behind the pill", async () => {
    const { container } = mount(
      topic([member("/w/api", 0), member("/w/web", 1)]),
      () => {},
      withSync({ "/w/web": CONFLICTED, "/w/api": branchSync({ upstream: { ahead: 1, behind: 0, has_upstream: true, gone: false, rewritten: false, superseded: false } }) }),
    );

    const pill = container.querySelector("[data-topic-sync]")!;
    expect(pill.getAttribute("data-topic-sync")).toBe("conflicts");
    // The loudest member's own glyphs, and the tooltip says whose they are.
    expect(pill.querySelector("[data-sync-mark=conflict]")).toBeTruthy();

    fireEvent.pointerEnter(pill.querySelector("[data-sync-marks]")!);
    expect((await screen.findByRole("tooltip")).textContent).toContain("web");
  });

  it("dots only the members that have something to report", () => {
    const { container } = mount(
      topic([member("/w/api", 0), member("/w/web", 1), member("/o/dotfiles", 2)]),
      () => {},
      withSync({ "/w/web": CONFLICTED, "/o/dotfiles": branchSync({ dirty: true }) }),
    );

    const dotted = Array.from(container.querySelectorAll("[data-member-sync]"));
    expect(dotted.length).toBe(1);
    expect(dotted[0].getAttribute("data-member-sync")).toBe("conflicts");

    // Dirty is a marker beside the scale, not a step on it: its own corner, and
    // no roll-up (the pill above reports the conflict, not the typing).
    const dirty = Array.from(container.querySelectorAll("[data-member-dirty]"));
    expect(dirty.length).toBe(1);
    expect(dirty[0].closest("[data-chip]")?.getAttribute("data-chip")).toBe("/o/dotfiles");
  });

  it("says nothing at all when the only news is that somebody is mid-edit", () => {
    const { container } = mount(
      topic([member("/w/api", 0)]),
      () => {},
      withSync({ "/w/api": branchSync({ dirty: true }) }),
    );

    expect(container.querySelector("[data-topic-sync]")).toBeNull();
    expect(container.querySelector("[data-member-dirty]")).toBeTruthy();
  });

  it("keeps a Topic with news the same shape as one without", () => {
    // jsdom has no layout, so "the same height" is pinned structurally: the
    // roll-up goes inside the name's own line, so the row gains no block.
    const members = [member("/w/api", 0), member("/w/web", 1)];
    const quiet = mount(topic(members)).container.querySelector("[data-topic]")!;
    const loud = mount(topic(members), () => {}, withSync({ "/w/web": CONFLICTED })).container
      .querySelector("[data-topic]")!;

    expect(loud.children.length).toBe(quiet.children.length);
    expect(loud.querySelector("[data-topic-sync]")!.parentElement!.className).toBe(
      loud.querySelector("[data-name]")!.parentElement!.className,
    );
  });

  it("stays clean under axe with a roll-up and dotted members", async () => {
    const { container } = mount(
      topic([member("/w/api", 0), member("/w/web", 1)]),
      () => {},
      withSync({ "/w/web": CONFLICTED, "/w/api": branchSync({ dirty: true }) }),
    );

    expect(container.querySelector("[data-topic-sync]")).toBeTruthy();
    await expectNoAxeViolations(container);
  });
});

describe("a Topic's chat status", () => {
  it("lights the title line when one of its chats waits on you", () => {
    const none = { waitingForApproval: 0, waitingForAnswer: 0, executing: 0, idle: 0, running: 0 };
    const [status, setStatus] = createSignal<Rollup>(none);
    const { container } = mount(topic([member("/w/api", 0)]), () => {}, { status });
    const head = container.querySelector(`.${styles.head}`)!;
    expect(head.querySelector("[title='Waiting for approval']")).toBeNull();

    setStatus({ ...none, waitingForApproval: 1, executing: 2 });
    expect(head.querySelector("[title='Waiting for approval']")).toBeTruthy();
    expect(head.querySelector("[title='Executing']")?.textContent).toBe("2");
  });
});

describe("a reference member", () => {
  const reference = (repoPath: string, order: number, branch = "main", defaultBranch = "main"): Member => ({
    ...member(repoPath, order),
    mode: "reference",
    checkout: { path: repoPath, branch, defaultBranch },
  });
  const behind = branchSync({
    upstream: { ahead: 0, behind: 3, has_upstream: true, gone: false, rewritten: false, superseded: false },
  });

  it("wears a lock on its chip and its row, and reads as a reference", async () => {
    const { container } = mount(topic([reference("/w/api", 0), member("/w/web", 1)]));
    const locked = Array.from(container.querySelectorAll("[data-chip] [data-reference]"));
    expect(locked.map((l) => l.closest("[data-chip]")!.getAttribute("data-chip"))).toEqual(["/w/api"]);

    await expand();
    const [api, web] = memberRows(container);
    expect(api.querySelector("[data-reference]")).toBeTruthy();
    expect(api.querySelector("[data-member-state]")!.textContent).toBe("Reference");
    expect(web.querySelector("[data-reference]")).toBeNull();
    expect(web.querySelector("[data-member-state]")!.textContent).toBe("Ready");
  });

  it("marks how far the checkout is behind origin", async () => {
    const { container } = mount(topic([reference("/w/api", 0)]), () => {}, {
      memberSync: () => behind,
    });
    await expand();
    expect(memberRows(container)[0].querySelector("[data-sync-mark]")).toBeTruthy();
  });

  it("warns when the checkout is off its default branch, or has edits of its own", async () => {
    const off = mount(topic([reference("/w/api", 0, "feature/x", "main")]));
    await expand();
    expect(memberRows(off.container)[0].querySelector("[data-member-warning]")!.textContent).toBe(
      "On feature/x, not main",
    );
    off.unmount();

    const dirty = mount(topic([reference("/w/api", 0)]), () => {}, { memberSync: () => branchSync({ dirty: true }) });
    await expand();
    expect(memberRows(dirty.container)[0].querySelector("[data-member-warning]")!.textContent).toBe(
      "Has uncommitted changes",
    );
    dirty.unmount();

    const clean = mount(topic([reference("/w/api", 0)]), () => {}, { memberSync: () => branchSync() });
    await expand();
    expect(memberRows(clean.container)[0].querySelector("[data-member-warning]")).toBeNull();
  });

  it("carries the lock onto the chip a file tab and the breadcrumb wear", () => {
    const { container } = render(() => <TabMemberChip member={tintedMember(reference("/w/api", 0), SPACES)} />);
    expect(container.querySelector("[data-reference]")).toBeTruthy();
    const plain = render(() => <TabMemberChip member={tintedMember(member("/w/web", 0), SPACES)} />);
    expect(plain.container.querySelector("[data-reference]")).toBeNull();
  });
});

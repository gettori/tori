import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import type { Member, Topic } from "../../utils/topics";

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  answer: null as unknown,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args });
    return Promise.resolve(bridge.answer);
  },
}));

const { default: MoveTopicDialog } = await import("./MoveTopicDialog");
const { refusedReason } = await import("../../utils/topics");
const { spaceOfMember } = await import("../../utils/topicMembers");

const SPACES = [
  {
    name: "saga",
    projects: [
      { name: "api", path: "/s/api" },
      { name: "web", path: "/s/web" },
    ],
  },
  { name: "craft", projects: [{ name: "cms", path: "/c/cms" }] },
  { name: "lab", projects: [] },
];

const member = (repoPath: string, order: number): Member => ({
  repoPath,
  displayName: repoPath.split("/").pop()!,
  mode: "reference",
  worktreePath: null,
  state: { kind: "present" },
  order,
});
const topic = (members: Member[], space?: string): Topic => ({
  id: "t1",
  name: "Checkout",
  branch: "feat/checkout",
  members,
  createdAt: 0,
  ...(space ? { space } : {}),
});

function mount(t: Topic) {
  const onDone = vi.fn();
  render(() => <MoveTopicDialog topic={t} spaces={SPACES} onDone={onDone} onCancel={() => {}} />);
  return onDone;
}

beforeEach(() => {
  bridge.calls = [];
  bridge.answer = null;
});

describe("refusedReason", () => {
  const homeOf = (m: Member) => spaceOfMember(m, SPACES)?.name ?? null;
  it("names the members outside the space by the one space they are in", () => {
    const t = topic([member("/s/api", 0), member("/s/web", 1)]);
    expect(refusedReason(t, "craft", homeOf)).toBe("api and web are in saga");
  });

  it("groups the members by space when they come from several", () => {
    const t = topic([member("/s/api", 0), member("/c/cms", 1), member("/s/web", 2)]);
    expect(refusedReason(t, "lab", homeOf)).toBe("api and web are in saga; cms is in craft");
    expect(refusedReason(t, "saga", homeOf)).toBe("cms is in craft");
  });
});

describe("MoveTopicDialog", () => {
  it("offers Topics first, then every space, and marks where the Topic is now", () => {
    mount(topic([member("/s/api", 0)], "saga"));
    expect(screen.getByText("Now in saga")).toBeTruthy();
    const named = ["Topics", "saga", "craft", "lab"].map((n) =>
      screen.getByRole("radio", { name: new RegExp(`^${n}`) }),
    );
    expect(screen.getAllByRole("radio")).toEqual(named);
    expect(screen.getByRole("radio", { name: /^saga/ }).textContent).toContain("Current");
  });

  it("refuses a space a member sits outside, in place", () => {
    mount(topic([member("/s/api", 0), member("/s/web", 1)]));
    const craft = screen.getByRole("radio", { name: /^craft/ });
    expect(craft.getAttribute("aria-disabled")).toBe("true");
    expect(craft.textContent).toContain("api and web are in saga");
    fireEvent.click(craft);
    expect(craft.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("radio", { name: /^saga/ }).getAttribute("aria-disabled")).toBeNull();
  });

  it("moves to the picked space and names it on the button", async () => {
    const moved = topic([member("/s/api", 0)], "saga");
    bridge.answer = moved;
    const onDone = mount(topic([member("/s/api", 0)]));
    expect((screen.getByRole("button", { name: "Move" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /^saga/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move to saga" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(moved));
    expect(bridge.calls).toEqual([{ cmd: "set_topic_space", args: { topicId: "t1", space: "saga" } }]);
  });

  it("sends null to list a space Topic in Topics", async () => {
    bridge.answer = topic([member("/s/api", 0)]);
    const onDone = mount(topic([member("/s/api", 0)], "saga"));
    fireEvent.click(screen.getByRole("radio", { name: /^Topics/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move to Topics" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(bridge.calls).toEqual([{ cmd: "set_topic_space", args: { topicId: "t1", space: null } }]);
  });
});

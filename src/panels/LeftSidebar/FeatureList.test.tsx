import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import type { Feature, Member, MemberState } from "../../utils/features";

function member(repoPath: string, order: number, state: MemberState = { kind: "present" }): Member {
  return {
    repoPath,
    displayName: repoPath.split("/").pop()!,
    worktreePath: null,
    state,
    order,
  };
}

const AUTH: Feature = {
  id: "auth-1",
  name: "Auth",
  branch: "feat/auth",
  createdAt: 1,
  members: [member("/w/api", 0), member("/w/web", 1)],
};
const PAY: Feature = {
  id: "pay-1",
  name: "Payments",
  branch: "feat/payments",
  createdAt: 2,
  members: [member("/w/api", 0), member("/w/ledger", 1, { kind: "failed", reason: "refusing to overwrite" })],
};

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  features: null as Feature[] | null,
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "list_features") return Promise.resolve(bridge.features);
    if (cmd === "retry_member") {
      const fixed = {
        ...PAY,
        members: PAY.members.map((m) => (m.repoPath === args.repoPath ? { ...m, state: { kind: "present" } } : m)),
      };
      return Promise.resolve(fixed);
    }
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (e: { payload: unknown }) => void) => {
    bridge.handlers.set(name, handler);
    return Promise.resolve(() => bridge.handlers.delete(name));
  },
  emit: () => Promise.resolve(),
}));

const { default: FeatureList } = await import("./FeatureList");

const SPACES = [{ name: "work", projects: [{ path: "/w/api" }, { path: "/w/web" }] }];
const listCalls = () => bridge.calls.filter((c) => c.cmd === "list_features").length;

describe("FeatureList", () => {
  beforeEach(() => {
    bridge.calls.length = 0;
    bridge.handlers.clear();
    bridge.features = [AUTH, PAY];
  });

  it("renders one row per Feature and filters by name or member", async () => {
    const [query, setQuery] = (await import("solid-js")).createSignal("");
    render(() => <FeatureList spaces={SPACES} query={query()} />);
    await screen.findByText("Auth");
    expect(screen.getByText("Payments")).toBeTruthy();
    setQuery("ledger");
    await waitFor(() => expect(screen.queryByText("Auth")).toBeNull());
    expect(screen.getByText("Payments")).toBeTruthy();
    setQuery("nothing");
    await screen.findByText("No Feature matches the filter.");
  });

  it("reads a null answer as no Features", async () => {
    bridge.features = null;
    render(() => <FeatureList spaces={SPACES} query="" />);
    await screen.findByText("No Features yet.");
  });

  it("applies a features://changed payload without a refetch", async () => {
    render(() => <FeatureList spaces={SPACES} query="" />);
    await screen.findByText("Payments");
    await waitFor(() => expect(bridge.handlers.has("features://changed")).toBe(true));
    expect(listCalls()).toBe(1);
    expect(screen.getByRole("img", { name: "Failed" })).toBeTruthy();

    const flipped = {
      ...PAY,
      members: PAY.members.map((m) => ({
        ...m,
        state: { kind: "present" } as MemberState,
      })),
    };
    bridge.handlers.get("features://changed")!({ payload: flipped });
    await waitFor(() => expect(screen.queryByRole("img", { name: "Failed" })).toBeNull());
    expect(listCalls()).toBe(1);

    const fresh: Feature = {
      id: "new-1",
      name: "Brand new",
      branch: "feat/brand-new",
      createdAt: 3,
      members: [member("/w/api", 0, { kind: "failed", reason: "pending" })],
    };
    bridge.handlers.get("features://changed")!({ payload: fresh });
    await screen.findByText("Brand new");
    expect(listCalls()).toBe(1);

    bridge.handlers.get("config://changed")!({ payload: null });
    await waitFor(() => expect(listCalls()).toBe(2));
  });

  it("wires Retry to retry_member and applies the answer", async () => {
    render(() => <FeatureList spaces={SPACES} query="" />);
    const retry = await screen.findByRole("button", { name: "Retry ledger" });
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry ledger" })).toBeNull());
    const call = bridge.calls.find((c) => c.cmd === "retry_member")!;
    expect(call.args).toEqual({ featureId: "pay-1", repoPath: "/w/ledger" });
  });
});

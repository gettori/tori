import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent, waitFor } from "../../src/test/harness";
import NewSheet from "./NewSheet";
import type { RemoteClient } from "./remote";
import type { Unit } from "./tree";

const unit: Unit = { label: "main", folder: "/work/app", branch: "main", kind: "plain", isCurrent: true };
const lists = {
  lists: [
    {
      rows: [
        { key: "i1", display: "#1", title: "Fix the login", url: "", kind: "issue" },
        { key: "r1", display: "#9", title: "Bump deps", url: "", kind: "reviewRequest" },
      ],
    },
  ],
};

function mount(assigned: () => Promise<unknown>) {
  const request = vi.fn(async (method: string) => {
    if (method === "issues.assigned") return assigned();
    if (method === "agents.list") return { agents: [{ id: "claude", label: "Claude" }], remembered: null };
    return [];
  });
  const client = {
    status: () => "open",
    update: () => null,
    generation: () => 1,
    request,
    subscribe: () => () => {},
  } as unknown as RemoteClient;
  render(() => <NewSheet client={client} unit={unit} project="/work/app" onStarted={() => {}} onDone={() => {}} />);
  return request;
}

const asked = (request: ReturnType<typeof mount>) => request.mock.calls.filter(([m]) => m === "issues.assigned").length;

describe("the new session sheet's assigned list", () => {
  it("says it is loading until the list lands, then lists the issues", async () => {
    let land!: (value: unknown) => void;
    mount(() => new Promise((yes) => (land = yes)));
    fireEvent.click(await screen.findByText("From an issue"));
    expect(await screen.findByText("Loading")).toBeTruthy();
    expect(screen.queryByText("Nothing assigned")).toBeNull();

    land(lists);
    expect(await screen.findByText("Fix the login")).toBeTruthy();
    expect(screen.queryByText("Bump deps")).toBeNull();
  });

  it("filters the same answer for a review without asking again", async () => {
    const request = mount(async () => lists);
    fireEvent.click(await screen.findByText("From an issue"));
    await screen.findByText("Fix the login");

    fireEvent.click(screen.getByText("Review a PR"));
    expect(await screen.findByText("Bump deps")).toBeTruthy();
    expect(screen.queryByText("Fix the login")).toBeNull();
    expect(asked(request)).toBe(1);
  });

  it("says the list could not be read instead of nothing assigned, and tries again", async () => {
    let fail = true;
    mount(async () => (fail ? Promise.reject("no forge account") : lists));
    fireEvent.click(await screen.findByText("From an issue"));
    expect(await screen.findByText(/no forge account/)).toBeTruthy();
    expect(screen.queryByText("Nothing assigned")).toBeNull();

    fail = false;
    fireEvent.click(screen.getByText("Try again"));
    await waitFor(() => expect(screen.getByText("Fix the login")).toBeTruthy());
  });
});

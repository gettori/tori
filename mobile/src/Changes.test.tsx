import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent, waitFor } from "../../src/test/harness";
import ChangesSheet from "./Changes";
import type { RemoteClient } from "./remote";

type Answer = (args: Record<string, unknown>) => Promise<unknown>;

function mount(answers: Record<string, Answer>) {
  const request = vi.fn((method: string, args: Record<string, unknown>) =>
    answers[method] ? answers[method](args) : Promise.resolve(null),
  );
  const client = {
    status: () => "open",
    update: () => null,
    generation: () => 1,
    request,
    subscribe: () => () => {},
  } as unknown as RemoteClient;
  return { ...render(() => <ChangesSheet client={client} id="s-1" onDone={() => {}} />), request };
}

function hold<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

const turns = [
  { turn: 1, kind: "", file_count: 2 },
  { turn: 2, kind: "", file_count: 1 },
];

describe("the Changes sheet", () => {
  it("says it is loading until the turns land, then lists them", async () => {
    const list = hold<unknown>();
    mount({ "checkpoints.list": () => list.promise });
    expect(await screen.findByText("Loading")).toBeTruthy();
    expect(screen.queryByText("No changes recorded")).toBeNull();

    list.resolve(turns);
    expect(await screen.findByText("Turn 2")).toBeTruthy();
    expect(screen.queryByText("Loading")).toBeNull();
  });

  it("names the turn in the head while its diff loads, then shows the diff", async () => {
    const diff = hold<unknown>();
    mount({ "checkpoints.list": async () => turns, "checkpoint.diff": () => diff.promise });
    fireEvent.click(await screen.findByText("Turn 2"));
    expect(await screen.findByText("Loading")).toBeTruthy();
    expect(screen.getByRole("dialog").querySelector("header")?.textContent).toContain("Turn 2");

    diff.resolve({ files: [], diff: "+added line" });
    expect(await screen.findByText(/\+added line/)).toBeTruthy();
  });

  it("says the turns could not be read instead of calling them empty, and tries again", async () => {
    let fail = true;
    mount({ "checkpoints.list": async () => (fail ? Promise.reject("socket closed") : turns) });
    expect(await screen.findByText(/socket closed/)).toBeTruthy();
    expect(screen.queryByText("No changes recorded")).toBeNull();

    fail = false;
    fireEvent.click(screen.getByText("Try again"));
    expect(await screen.findByText("Turn 1")).toBeTruthy();
  });

  it("says a diff could not be read, and Back still lists the turns", async () => {
    mount({ "checkpoints.list": async () => turns, "checkpoint.diff": () => Promise.reject("no such turn") });
    fireEvent.click(await screen.findByText("Turn 1"));
    expect(await screen.findByText(/no such turn/)).toBeTruthy();

    fireEvent.click(screen.getByText("Back"));
    await waitFor(() => expect(screen.getByText("Turn 2")).toBeTruthy());
  });
});

import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import AddBranchDialog from "./AddBranchDialog";
import type { Issue, IssueRef } from "../../utils/issues";

const foreign = "gettori/tickets#31";

const row: IssueRef = {
  key: foreign,
  display: foreign,
  title: "Dogfood the autopilot",
  url: "https://github.com/gettori/tickets/issues/31",
  kind: "issue",
};

const issue: Issue = {
  key: foreign,
  display: foreign,
  title: row.title,
  body: "",
  url: row.url,
  suggestedBranch: "31-dogfood-the-autopilot",
};

describe("AddBranchDialog, starting from an issue in another repo", () => {
  it("lists it by its repo and starts it under that key", async () => {
    const get = vi.fn(() => Promise.resolve(issue));
    const onConfirm = vi.fn();
    render(() => (
      <AddBranchDialog
        mode="worktree"
        projectName="tori"
        projectPath="~/tori"
        locals={["main"]}
        remotes={["main"]}
        taken={[]}
        fetching={false}
        busy={false}
        baseDefault="main"
        issues={{
          assigned: () => Promise.resolve({ rows: [row], skipped: [] }),
          get,
          find: () => Promise.resolve({ hits: [], skipped: [] }),
          ahead: () => Promise.resolve(false),
        }}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Issue" }));
    const option = await screen.findByRole("option", { name: new RegExp(row.title) });
    expect(option.textContent).toContain(foreign);
    fireEvent.click(option);
    await waitFor(() => expect(get).toHaveBeenCalledWith(foreign));
    const start = await screen.findByRole("button", { name: `Start from ${foreign}` });
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    fireEvent.click(start);
    expect(onConfirm.mock.calls[0][0].issue.issue.key).toBe(foreign);
  });
});

describe("AddBranchDialog, typing an issue", () => {
  const here: IssueRef = { ...row, key: "31", display: "#31", title: "Here too" };

  function open(find: (input: string) => Promise<{ hits: IssueRef[]; skipped: string[] }>) {
    const get = vi.fn((key: string) => Promise.resolve({ ...issue, key, display: key }));
    render(() => (
      <AddBranchDialog
        mode="worktree"
        projectName="tori"
        projectPath="~/tori"
        locals={["main"]}
        remotes={["main"]}
        taken={[]}
        fetching={false}
        busy={false}
        baseDefault="main"
        issues={{
          assigned: () => Promise.resolve({ rows: [], skipped: [] }),
          get,
          find: vi.fn(find),
          ahead: () => Promise.resolve(false),
        }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Issue" }));
    return get;
  }

  it("lists a number found in two repos and notes the repo it could not read", async () => {
    const get = open(() => Promise.resolve({ hits: [here, row], skipped: ["acme/secret"] }));
    const input = screen.getByRole("combobox");
    fireEvent.input(input, { target: { value: "31" } });
    fireEvent.click(await screen.findByRole("button", { name: /Open issue/ }));
    expect(await screen.findByRole("button", { name: /Here too/ })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(row.title) }));
    await waitFor(() => expect(get).toHaveBeenCalledWith(foreign));
    expect(screen.getByText(/no access: acme\/secret/)).toBeTruthy();
  });

  it("opens a repo#N with one hit straight away", async () => {
    const get = open(() => Promise.resolve({ hits: [row], skipped: [] }));
    fireEvent.input(screen.getByRole("combobox"), { target: { value: "tickets#31" } });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await waitFor(() => expect(get).toHaveBeenCalledWith(foreign));
  });
});

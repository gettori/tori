import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expectNoAxeViolations } from "../../test/axe";
import RepoChecklist from "./RepoChecklist";

const SPACES = [
  {
    name: "pinned",
    external: true,
    projects: [{ name: "dotfiles", path: "/p/dotfiles" }],
  },
  {
    name: "work",
    external: false,
    projects: [
      { name: "api", path: "/w/api" },
      { name: "web", path: "/w/web" },
    ],
  },
  {
    name: "infra",
    external: false,
    projects: [{ name: "terraform", path: "/i/terraform" }],
  },
];

const box = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

describe("RepoChecklist", () => {
  it("lists root Spaces before pinned ones and reports picks in that order", async () => {
    const onChange = vi.fn();
    const [value, setValue] = createSignal<string[]>([]);
    render(() => (
      <RepoChecklist
        spaces={SPACES}
        value={value()}
        onChange={(v) => {
          onChange(v);
          setValue(v);
        }}
      />
    ));

    const group = (name: string) => screen.getByRole("group", { name });
    const before = (a: HTMLElement, b: HTMLElement) =>
      !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(group("work"), group("infra"))).toBe(true);
    expect(before(group("infra"), group("pinned"))).toBe(true);

    fireEvent.click(box("dotfiles"));
    fireEvent.click(box("api"));
    expect(onChange).toHaveBeenLastCalledWith(["/w/api", "/p/dotfiles"]);
    expect(box("api").checked).toBe(true);
    expect(box("dotfiles").checked).toBe(true);

    fireEvent.click(box("dotfiles"));
    expect(onChange).toHaveBeenLastCalledWith(["/w/api"]);
    await expectNoAxeViolations(document.body);
  });

  it("drops excluded repos and any Space left empty", () => {
    render(() => <RepoChecklist spaces={SPACES} value={[]} onChange={() => {}} exclude={["/w/api", "/i/terraform"]} />);
    expect(screen.queryByRole("checkbox", { name: "api" })).toBeNull();
    expect(screen.queryByRole("group", { name: "infra" })).toBeNull();
    expect(box("web")).toBeTruthy();
  });

  it("hangs the collision element under its repo", () => {
    render(() => (
      <RepoChecklist
        spaces={SPACES}
        value={["/w/api"]}
        onChange={() => {}}
        collision={(p) => (p === "/w/api" ? <span>feat/x already exists</span> : undefined)}
      />
    ));
    expect(screen.getByText("feat/x already exists")).toBeTruthy();
    expect(box("api").getAttribute("aria-describedby")).toBeTruthy();
  });
});

import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expectNoAxeViolations } from "../../test/axe";
import RepoChecklist from "./RepoChecklist";

const SPACES = [
  {
    name: "work",
    projects: [
      { name: "api", path: "/w/api" },
      { name: "web", path: "/w/web" },
    ],
  },
  {
    name: "infra",
    projects: [{ name: "terraform", path: "/i/terraform" }],
  },
  {
    name: "dots",
    projects: [{ name: "dotfiles", path: "/p/dotfiles" }],
  },
];

const box = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

describe("RepoChecklist", () => {
  it("lists Spaces in rail order and reports picks in that order", async () => {
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
    expect(before(group("infra"), group("dots"))).toBe(true);

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
});

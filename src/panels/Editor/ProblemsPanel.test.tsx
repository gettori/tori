import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { setDiagnostics } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { expectNoAxeViolations } from "../../test/axe";
import ProblemsPanel from "./ProblemsPanel";
import { problemsFromState } from "./problemsFromState";
import { clearDiagnostics, publishDiagnostics, type Problem } from "../../utils/diagnostics";
import { onWith, OPEN_IN_EDITOR, type OpenInEditor } from "../../utils/events";
import type { MemberRoot } from "../../utils/topicMembers";
import type { Selection } from "../LeftSidebar/LeftSidebar";

// The store spans every warm project, so what this panel is really about is
// scope: which of those diagnostics belong to what is selected, and inside a
// Topic, which member each one belongs to.

const API = "/w/feat/api";
const WEB = "/w/feat/web";

const problem = (line: number, message: string, severity: Problem["severity"] = "error"): Problem => ({
  line,
  endLine: line,
  column: 1,
  severity,
  message,
});

const member = (label: string, path: string): MemberRoot => ({
  path,
  repoPath: path,
  label,
  state: { label: "Ready", usable: true, action: null, reason: null },
});

const unit = (folderPath: string) => ({ folderPath }) as unknown as Selection;

let opened: OpenInEditor[] = [];
let offOpen: (() => void) | undefined;

beforeEach(() => {
  clearDiagnostics();
  opened = [];
  offOpen = onWith<OpenInEditor>(OPEN_IN_EDITOR, (d) => opened.push(d));
});
afterEach(() => {
  offOpen?.();
  clearDiagnostics();
});

describe("a branch unit's problems", () => {
  it("lists what is under the selected folder and nothing else", () => {
    publishDiagnostics(`${API}/src/a.ts`, [problem(3, "mine")]);
    publishDiagnostics("/elsewhere/b.ts", [problem(1, "not mine")]);
    render(() => <ProblemsPanel selected={unit(API)} />);
    expect(screen.getByText("mine")).toBeTruthy();
    expect(screen.queryByText("not mine")).toBeNull();
  });

  it("draws no member header when there are no members", () => {
    publishDiagnostics(`${API}/src/a.ts`, [problem(3, "mine")]);
    render(() => <ProblemsPanel selected={unit(API)} />);
    expect(screen.queryByRole("button", { name: /api/ })).toBeNull();
  });

  it("says nothing is wrong when nothing is", () => {
    render(() => <ProblemsPanel selected={unit(API)} />);
    expect(screen.getByText("No problems in the open files.")).toBeTruthy();
  });

  it("names the tool that reported a problem", () => {
    const state = EditorState.create({ doc: "let a = 1;\n" });
    const linted = state.update(
      setDiagnostics(state, [{ from: 4, to: 5, severity: "warning", message: "'a' is unused", source: "eslint" }]),
    ).state;
    publishDiagnostics(`${API}/src/a.ts`, problemsFromState(linted));
    render(() => <ProblemsPanel selected={unit(API)} />);
    expect(screen.getByText("'a' is unused").parentElement?.textContent).toContain("eslint");
  });
});

describe("a Topic's problems", () => {
  const ROOTS = [member("api", API), member("web", WEB)];

  it("lists a file under the member it is in", () => {
    publishDiagnostics(`${API}/src/a.ts`, [problem(3, "api broke")]);
    publishDiagnostics(`${WEB}/src/b.ts`, [problem(9, "web broke")]);
    const { container } = render(() => <ProblemsPanel selected={unit(API)} roots={ROOTS} />);

    const sections = container.querySelectorAll("[data-root]");
    expect([...sections].map((s) => s.getAttribute("data-root"))).toEqual([API, WEB]);
    expect(sections[0].textContent).toContain("api broke");
    expect(sections[0].textContent).not.toContain("web broke");
    expect(sections[1].textContent).toContain("web broke");
  });

  it("answers for the member you are not looking at", () => {
    // The whole point of the change: `activeRoot` is api, the error is in web,
    // and the panel still has it.
    publishDiagnostics(`${WEB}/src/b.ts`, [problem(9, "web broke")]);
    render(() => <ProblemsPanel selected={unit(API)} roots={ROOTS} />);
    expect(screen.getByText("web broke")).toBeTruthy();
  });

  it("counts each member's problems on its own header", () => {
    publishDiagnostics(`${API}/src/a.ts`, [problem(3, "one"), problem(4, "two")]);
    publishDiagnostics(`${WEB}/src/b.ts`, [problem(9, "three")]);
    render(() => <ProblemsPanel selected={unit(API)} roots={ROOTS} />);
    expect(screen.getByRole("button", { name: /^api/ }).textContent).toContain("2");
    expect(screen.getByRole("button", { name: /^web/ }).textContent).toContain("1");
  });

  it("orders each member's files worst-first, independently of the other's", () => {
    publishDiagnostics(`${API}/src/warn.ts`, [problem(1, "api warning", "warning")]);
    publishDiagnostics(`${API}/src/err.ts`, [problem(1, "api error")]);
    const { container } = render(() => <ProblemsPanel selected={unit(API)} roots={ROOTS} />);
    const names = [...container.querySelectorAll("[data-root]")[0].querySelectorAll("[title]")].map((n) =>
      n.getAttribute("title"),
    );
    expect(names[0]).toBe(`${API}/src/err.ts`);
  });

  it("still opens the file at the line when a row is clicked", () => {
    publishDiagnostics(`${WEB}/src/b.ts`, [problem(9, "web broke")]);
    render(() => <ProblemsPanel selected={unit(API)} roots={ROOTS} />);
    fireEvent.click(screen.getByText("web broke"));
    expect(opened).toEqual([{ path: `${WEB}/src/b.ts`, line: 9, col: 1 }]);
  });

  it("leaves a collapsed member collapsed when a diagnostic lands elsewhere", async () => {
    // The sections are rebuilt on every publish, so a referentially-keyed list
    // would remount each one and reopen what the reader had just closed.
    publishDiagnostics(`${API}/src/a.ts`, [problem(3, "api broke")]);
    render(() => <ProblemsPanel selected={unit(API)} roots={ROOTS} />);
    const head = screen.getByRole("button", { name: /^api/ });
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");

    publishDiagnostics(`${WEB}/src/b.ts`, [problem(9, "web broke")]);
    await waitFor(() => expect(screen.getByText("web broke")).toBeTruthy());
    expect(screen.getByRole("button", { name: /^api/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("api broke")).toBeNull();
  });

  it("keeps a member that cannot be opened on screen, saying why", () => {
    const gone: MemberRoot = {
      path: "/repos/web",
      repoPath: "/repos/web",
      label: "web",
      state: { label: "Worktree missing", usable: false, action: "recreate", reason: null },
    };
    publishDiagnostics(`${API}/src/a.ts`, [problem(3, "api broke")]);
    render(() => <ProblemsPanel selected={unit(API)} roots={[member("api", API), gone]} />);
    expect(screen.getByText("Worktree missing")).toBeTruthy();
  });
});

describe("the problems panel, to axe", () => {
  it("has no accessibility violations across two members", () => {
    publishDiagnostics(`${API}/src/a.ts`, [problem(3, "api broke")]);
    publishDiagnostics(`${WEB}/src/b.ts`, [problem(9, "web broke")]);
    const { container } = render(() => (
      <ProblemsPanel selected={unit(API)} roots={[member("api", API), member("web", WEB)]} />
    ));

    return expectNoAxeViolations(container);
  });
});

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { For } from "solid-js";
import MemberSection from "./MemberSection";
import { memberSectionsHeaded, type MemberRoot } from "../../utils/topicMembers";
import { expectNoAxeViolations } from "../../test/axe";

const ready = (label: string, path: string): MemberRoot => ({
  path,
  repoPath: path,
  label,
  state: { label: "Ready", usable: true, action: null, reason: null },
});

const FE = ready("frontend", "/wt/frontend");
const BE = ready("backend", "/wt/backend");
const DOCS = ready("docs", "/wt/docs");
const GONE: MemberRoot = {
  path: "/repos/backend",
  repoPath: "/repos/backend",
  label: "backend",
  state: { label: "Worktree missing", usable: false, action: "recreate", reason: null },
};

/** The panels decide headedness from the root list, so the two are exercised
 *  together: the rule and the markup it turns into are one answer. */
function mountAll(roots: MemberRoot[]) {
  return render(() => (
    <For each={roots}>
      {(root) => (
        <MemberSection root={root} headed={memberSectionsHeaded(roots)} count={2}>
          <div>rows for {root.label}</div>
        </MemberSection>
      )}
    </For>
  ));
}

describe("a member section", () => {
  it("draws no header for a single member that is ready", () => {
    // A branch unit, and a one-member Topic, look the same as they always did:
    // a header naming the only repo on screen is noise.
    mountAll([FE]);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("rows for frontend")).toBeTruthy();
  });

  it("names every member once there is more than one", () => {
    mountAll([FE, BE, DOCS]);
    expect(screen.getByRole("button", { name: /frontend/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /backend/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /docs/ })).toBeTruthy();
  });

  it("heads a lone broken member and draws no body under it", () => {
    // The badge is the only account of why there is nothing below, so the
    // header appears even though there is no second member to tell it from.
    mountAll([GONE]);
    expect(screen.getByText("Worktree missing")).toBeTruthy();
    expect(screen.queryByText("rows for backend")).toBeNull();
    // Not a toggle: there is nothing to expand.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("reads out the reason a member failed, rather than hiding it in a title", () => {
    mountAll([
      {
        ...GONE,
        state: { label: "Failed", usable: false, action: "retry", reason: "branch is checked out" },
      },
    ]);
    expect(screen.getByText("Failed: branch is checked out")).toBeTruthy();
  });

  it("collapses and reopens its own rows", () => {
    mountAll([FE, BE]);
    const head = screen.getByRole("button", { name: /frontend/ });
    expect(head.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("rows for frontend")).toBeNull();
    // The neighbour is untouched: a section owns only its own rows.
    expect(screen.getByText("rows for backend")).toBeTruthy();
    fireEvent.click(head);
    expect(screen.getByText("rows for frontend")).toBeTruthy();
  });

  it("names the trailing bucket instead of chipping it", () => {
    // Nothing to take initials from, and a neutral box would read as one more
    // member of the Topic.
    render(() => (
      <MemberSection root={null} headed>
        <div>stray rows</div>
      </MemberSection>
    ));
    const head = screen.getByRole("button", { name: /Outside this Feature/ });
    expect(head.textContent).toBe("Outside this Feature");
    expect(screen.getByText("stray rows")).toBeTruthy();
  });
});

describe("member sections, to axe", () => {
  it("have no accessibility violations across three members", () => {
    const { container } = mountAll([FE, BE, GONE]);

    return expectNoAxeViolations(container);
  });
});

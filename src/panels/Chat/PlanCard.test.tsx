import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import PlanCard from "./PlanCard";
import { applyEvent, initialChat } from "./chatStore";
import type { PlanItem } from "../../utils/chatTypes";

const SESSION = "11111111-2222-3333-4444-555555555555";

function plan(...items: [string, PlanItem["status"]][]): PlanItem[] {
  return items.map(([text, status]) => ({ text, status }));
}

describe("PlanCard", () => {
  it("renders nothing until a plan arrives", () => {
    const { container } = render(() => <PlanCard items={[]} />);
    expect(container.textContent).toBe("");
  });

  it("counts completed steps against the total", () => {
    const { container } = render(() => (
      <PlanCard items={plan(["read it", "completed"], ["fix it", "inProgress"], ["test it", "pending"])} />
    ));
    expect(container.textContent).toContain("1/3");
  });

  // The header exists so a glance answers "what is it doing" without reading
  // the list, which is the whole reason the card is pinned above the composer
  // rather than left to scroll away in the transcript.
  it("names the in-flight step in the header", () => {
    const { container } = render(() => (
      <PlanCard items={plan(["read it", "completed"], ["fix it", "inProgress"])} />
    ));
    const head = container.querySelector("[class*='planHead']");
    expect(head?.textContent).toContain("fix it");
  });

  it("says nothing about an in-flight step when none is running", () => {
    const { container } = render(() => (
      <PlanCard items={plan(["read it", "completed"], ["fix it", "completed"])} />
    ));
    const head = container.querySelector("[class*='planHead']");
    expect(head?.textContent).toContain("2/2");
    expect(head?.textContent).not.toContain("fix it");
  });

  // The verify: items flip to in-progress and completed as the turn runs.
  //
  // Driven through the real fold rather than by handing the component a list
  // per stage, so a `planUpdate` the store dropped fails here rather than
  // passing on a hand-built fixture. Each stage is a fresh mount because this
  // repo's DOM harness does not propagate a signal write through `<Show>` (a
  // pre-existing limitation, not this component's - a signal interpolated
  // directly into JSX does update). What is under test is the mapping from a
  // sequence of events to what the card says, and that is what this asserts.
  it("flips items to in-progress and completed as planUpdate events arrive", () => {
    const state = initialChat(SESSION);
    const after = (list: PlanItem[]) => {
      applyEvent(state, { type: "planUpdate", sessionId: SESSION, turnId: "t1", items: list });
      return render(() => <PlanCard items={state.plan} />).container;
    };

    expect(render(() => <PlanCard items={state.plan} />).container.textContent).toBe("");

    let c = after(plan(["read it", "inProgress"], ["fix it", "pending"], ["test it", "pending"]));
    expect(c.textContent).toContain("0/3");
    expect(c.querySelector("[class*='planHead']")?.textContent).toContain("read it");

    c = after(plan(["read it", "completed"], ["fix it", "inProgress"], ["test it", "pending"]));
    expect(c.textContent).toContain("1/3");
    expect(c.querySelector("[class*='planHead']")?.textContent).toContain("fix it");

    c = after(plan(["read it", "completed"], ["fix it", "completed"], ["test it", "completed"]));
    expect(c.textContent).toContain("3/3");
    // Every item settled, so nothing is claimed to be in flight any more.
    expect(c.querySelector("[class*='planActive']")).toBeNull();
  });

  // A plan is current state, not a transcript entry: a second update replaces
  // the first rather than stacking, which is why the store keeps one list.
  it("replaces the previous plan rather than appending to it", () => {
    const state = initialChat(SESSION);
    applyEvent(state, {
      type: "planUpdate",
      sessionId: SESSION,
      turnId: "t1",
      items: plan(["old step", "pending"]),
    });
    applyEvent(state, {
      type: "planUpdate",
      sessionId: SESSION,
      turnId: "t1",
      items: plan(["new step", "pending"]),
    });
    const { container } = render(() => <PlanCard items={state.plan} />);
    expect(container.textContent).toContain("new step");
    expect(container.textContent).not.toContain("old step");
    expect(container.querySelectorAll("li").length).toBe(1);
  });
});

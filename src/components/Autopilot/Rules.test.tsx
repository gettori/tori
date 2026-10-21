import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import Rules from "./Rules";
import type { RuleCard } from "./autopilot";

afterEach(cleanup);

const card = (paused: boolean): RuleCard => ({
  project: "/code/tori",
  name: "tori",
  on: "on a failed check",
  fired: "1 of 3 this hour",
  paused,
});

describe("pull request rules in the cockpit", () => {
  it("shows the hour's count while running", () => {
    render(() => <Rules rules={[card(false)]} />);
    expect(screen.getByText("1 of 3 this hour")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("offers Resume on a paused rule and resumes its project", () => {
    const onResume = vi.fn();
    render(() => <Rules rules={[card(true)]} onResume={onResume} />);
    expect(screen.getByText("1 of 3 this hour")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(onResume).toHaveBeenCalledWith("/code/tori");
  });
});

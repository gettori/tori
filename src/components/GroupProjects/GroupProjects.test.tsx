import { describe, it, expect } from "vite-plus/test";
import { render, screen } from "@solidjs/testing-library";
import GroupProjects, { HOME_NOTE } from "./GroupProjects";
import { initialPlan } from "../../utils/grouping";
import { MIXED } from "../../utils/grouping.fixture";

describe("GroupProjects", () => {
  it("shows every list for the mixed folder", () => {
    render(() => <GroupProjects scan={MIXED} plan={initialPlan(MIXED)} onPlan={() => {}} />);
    expect(screen.getByText(HOME_NOTE)).toBeTruthy();
    expect(screen.getByLabelText("Space for office/x/repo")).toBeTruthy();
    expect(screen.getByLabelText("Space for site")).toBeTruthy();
    expect(screen.getByText("Hide screenshots: it isn't a space")).toBeTruthy();
    expect(screen.getByText("photos (too big to scan)")).toBeTruthy();
    expect(screen.getByText("a/b/c/d/repo (too deep)")).toBeTruthy();
    expect(screen.getByText("office/x/repo -> office/repo")).toBeTruthy();
    expect(screen.getByText("site -> fonngroup/site")).toBeTruthy();
  });
});

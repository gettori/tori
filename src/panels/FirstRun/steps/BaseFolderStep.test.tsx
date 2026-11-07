import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import BaseFolderStep from "./BaseFolderStep";
import { MIXED } from "../../../utils/grouping.fixture";

describe("BaseFolderStep", () => {
  it("offers three ways forward from a refused folder", () => {
    const onChoose = vi.fn();
    const onCreate = vi.fn();
    const onDefault = vi.fn();
    render(() => (
      <BaseFolderStep
        root={null}
        spaces={[]}
        home="/u"
        onChoose={onChoose}
        onCreate={onCreate}
        onDefault={onDefault}
        pending={{ scan: { ...MIXED, refused: "This is a project." }, plan: null }}
      />
    ));
    expect(screen.getByText("This is a project.")).toBeTruthy();
    expect(screen.getByText("You can attach folders and move them into a space later.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Choose another folder" }));
    fireEvent.click(screen.getByRole("button", { name: "Create a new folder" }));
    fireEvent.click(screen.getByRole("button", { name: "Use ~/tori_projects" }));
    expect([onChoose, onCreate, onDefault].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
  });
});

import { describe, it, expect, vi } from "vite-plus/test";
import { render, fireEvent } from "@solidjs/testing-library";
import PromptFrom from "./PromptFrom";

describe("PromptFrom", () => {
  it("names the sender as a link that opens it", () => {
    const open = vi.fn();
    const { getByRole } = render(() => <PromptFrom name="Fix the login flow" onOpen={open} />);
    fireEvent.click(getByRole("button", { name: "Fix the login flow" }));
    expect(open).toHaveBeenCalledOnce();
  });

  it("names the sender as plain text where there is nowhere to go", () => {
    const { container, queryByRole } = render(() => <PromptFrom name="Fix the login flow" />);
    expect(container.textContent).toContain("from Fix the login flow");
    expect(queryByRole("button")).toBeNull();
  });
});

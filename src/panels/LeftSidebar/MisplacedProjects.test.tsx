import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import MisplacedProjects from "./MisplacedProjects";

describe("MisplacedProjects", () => {
  it("names each project outside a space and attaches the one clicked", () => {
    const onAttach = vi.fn();
    render(() => <MisplacedProjects paths={["/u/P/loose", "/u/P/work/client/deep"]} home="/u" onAttach={onAttach} />);
    fireEvent.click(screen.getByRole("button", { name: /2 projects aren't in a space/ }));
    expect(screen.getByText("loose")).toBeTruthy();
    expect(screen.getByText("deep")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /Attach to Home/ })[1]);
    expect(onAttach).toHaveBeenCalledWith("/u/P/work/client/deep");
  });
});

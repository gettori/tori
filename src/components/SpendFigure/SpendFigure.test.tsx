import { describe, expect, it } from "vite-plus/test";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import SpendFigure from "./SpendFigure";

describe("SpendFigure", () => {
  it("shows dollars", () => {
    render(() => <SpendFigure usage={{ tokens: 9, costUsd: 1.2, turns: 2 }} what="this pull request" />);
    expect(screen.getByText("$1.20")).toBeTruthy();
  });

  it("shows turns for an agent with no cost, and says why on focus", async () => {
    render(() => <SpendFigure usage={{ tokens: 0, costUsd: null, turns: 4 }} what="this pull request" />);
    const figure = screen.getByText("4 turns");
    figure.focus();
    fireEvent.focus(figure);
    expect(await screen.findByText(/no cost reported/)).toBeTruthy();
  });

  it("draws nothing when nothing was recorded", () => {
    const { container } = render(() => <SpendFigure usage={null} what="this pull request" />);
    expect(container.querySelector("[data-spend]")).toBeNull();
  });
});

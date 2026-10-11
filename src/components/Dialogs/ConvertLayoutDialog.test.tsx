import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import ConvertLayoutDialog, { type ConversionPreview } from "./ConvertLayoutDialog";

const PROJ = "/w/repo";

const preview: ConversionPreview = {
  branch: "feat/x",
  leaf: "x",
  target: `${PROJ}/x`,
  tori: [{ from: `${PROJ}/.tori/worktrees/t`, to: `${PROJ}/t` }],
  nested: [{ from: `${PROJ}/wt/n`, to: `${PROJ}/x/wt/n` }],
  outside: ["/elsewhere/o"],
  topics: ["auth"],
};

type Props = Parameters<typeof ConvertLayoutDialog>[0];

function open(props: Partial<Props> = {}) {
  const onConfirm = vi.fn();
  render(() => (
    <ConvertLayoutDialog
      projectName="repo"
      projectPath={PROJ}
      preview={preview}
      refusal={null}
      blockers={[]}
      busy={false}
      onConfirm={onConfirm}
      onCancel={() => {}}
      {...props}
    />
  ));
  return { onConfirm, convert: screen.getByRole("button", { name: "Convert" }) as HTMLButtonElement };
}

describe("ConvertLayoutDialog", () => {
  it("says what moves, what stays and what it costs before anything runs", () => {
    const { convert, onConfirm } = open();

    expect(screen.getByText("repo/x")).toBeTruthy();
    expect(screen.getByText(".git becomes .bare")).toBeTruthy();
    expect(screen.getByText("repo/.tori/worktrees/t -> repo/t")).toBeTruthy();
    expect(screen.getByText("repo/wt/n -> repo/x/wt/n")).toBeTruthy();
    expect(screen.getByText("/elsewhere/o")).toBeTruthy();
    expect(screen.getByText(/Nothing in git is lost/)).toBeTruthy();
    expect(screen.getByText(/Topic "auth" reads this repo's default branch/)).toBeTruthy();
    expect(screen.getByText(/Earlier agent sessions stay recorded at the old path/)).toBeTruthy();

    fireEvent.click(convert);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("shows a refusal in place of the plan and will not convert", () => {
    const { convert } = open({ preview: null, refusal: "A rebase is in progress. Finish or abort it first." });

    expect(screen.getByText("A rebase is in progress. Finish or abort it first.")).toBeTruthy();
    expect(screen.queryByText(".git becomes .bare")).toBeNull();
    expect(convert.disabled).toBe(true);
  });

  it("keeps the plan in view but will not convert past a blocker", () => {
    const { convert } = open({ blockers: ["1 file has unsaved changes in this project. Save or discard it first."] });

    expect(screen.getByText(/1 file has unsaved changes/)).toBeTruthy();
    expect(screen.getByText(".git becomes .bare")).toBeTruthy();
    expect(convert.disabled).toBe(true);
  });

  it("waits for the preview before it can convert", () => {
    const { convert } = open({ preview: null });

    expect(convert.disabled).toBe(true);
  });
});

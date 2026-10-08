import { describe, it, expect, vi } from "vite-plus/test";
import { fireEvent, render, screen } from "@solidjs/testing-library";

let saved: { verification: { commands: Record<string, string[]> } } | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "set_settings") {
      saved = args!.settings as typeof saved;
      return Promise.resolve(saved);
    }
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const { default: VerificationCommandsDialog } = await import("./VerificationCommandsDialog");
const { setProjectChecks } = await import("../../utils/verification");

const open = () =>
  render(() => (
    <VerificationCommandsDialog
      projectName="app"
      commands={["cargo test", "pnpm test"]}
      onSave={(commands) => void setProjectChecks("/work/app", commands)}
      onReset={() => void setProjectChecks("/work/app", [])}
      onCancel={() => {}}
    />
  ));

describe("the project's verification commands", () => {
  it("opens on the list in force, saves the edited list whole and resets by removing it", async () => {
    open();
    const list = screen.getByLabelText("One command per line") as HTMLTextAreaElement;
    expect(list.value).toBe("cargo test\npnpm test");

    fireEvent.input(list, { target: { value: "just ci\n\n  cargo test  \n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(saved?.verification.commands["/work/app"]).toEqual(["just ci", "cargo test"]));

    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    await vi.waitFor(() => expect(saved?.verification.commands).not.toHaveProperty("/work/app"));
  });
});

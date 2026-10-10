import { describe, it, expect, vi } from "vite-plus/test";
import { fireEvent, render, screen } from "@solidjs/testing-library";

const BUILT_IN = ["cargo test", "pnpm test"];
let saved: { verification: { enabled: boolean; commands: Record<string, string[]> } } | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "set_settings") {
      saved = args!.settings as typeof saved;
      return Promise.resolve(saved);
    }
    if (cmd === "verification_defaults") return Promise.resolve(BUILT_IN);
    if (cmd === "verification_commands") {
      return Promise.resolve(saved?.verification.commands[args!.project as string] ?? BUILT_IN);
    }
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const { default: ChecksSection } = await import("./ChecksSection");

describe("the project's verification commands", () => {
  it("opens on the list in force, saves the edited list whole, and a reset saved removes it", async () => {
    render(() => <ChecksSection projectPath="/work/app" />);
    const list = screen.getByLabelText("Verification commands") as HTMLTextAreaElement;
    await vi.waitFor(() => expect(list.value).toBe("cargo test\npnpm test"));

    fireEvent.input(list, { target: { value: "just ci\n\n  cargo test  \n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(saved?.verification.commands["/work/app"]).toEqual(["just ci", "cargo test"]));

    // Reset only refills the field; saving the built-in list as it is removes
    // the project's own list rather than copying the defaults into it.
    const reset = screen.getByRole("button", { name: "Reset to defaults" }) as HTMLButtonElement;
    await vi.waitFor(() => expect(reset.disabled).toBe(false));
    fireEvent.click(reset);
    expect(list.value).toBe("cargo test\npnpm test");
    expect(saved?.verification.commands["/work/app"]).toEqual(["just ci", "cargo test"]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(saved?.verification.commands).not.toHaveProperty("/work/app"));
  });
});

import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, fireEvent } from "@solidjs/testing-library";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { pointerClick } from "../../../../test/menus";
import { unstubbed } from "../../../../test/settingsBackend";
import ExecutionSection from "../../../ProjectSettings/ExecutionSection";
import { loadWorkspaceSettings, settings } from "../../settingsStore";
import UnattendedLists from "./UnattendedLists";

const BUILT_IN = { deny: ["aws", "kubectl"], allowedDomains: ["pypi.org"] };
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "set_settings") return args.settings;
    if (cmd === "unattended_defaults") return BUILT_IN;
    return unstubbed(cmd);
  });
  await loadWorkspaceSettings(null);
});

describe("the execution policy", () => {
  it("starts a project boxed when unattended and saves the level picked", async () => {
    render(() => <ExecutionSection projectPath="/work/app" />);
    expect(screen.getByLabelText("Sandbox").textContent).toContain("Boxed when unattended");
    pointerClick(screen.getByLabelText("Sandbox"));
    await screen.findByRole("listbox");
    pointerClick(screen.getByRole("option", { name: "Always boxed" }));
    await macrotask();
    expect(settings.execution?.["/work/app"]).toBe("alwaysBoxed");
  });

  it("shows the built-in deny list, saves an edit whole, and a reset goes back to built-in", async () => {
    render(() => <UnattendedLists shown={() => true} query="" />);
    const deny = screen.getByLabelText("Never run unattended") as HTMLTextAreaElement;
    await vi.waitFor(() => expect(deny.value).toBe("aws\nkubectl"));

    fireEvent.change(deny, { target: { value: "aws\n\n  flyctl  \n" } });
    await macrotask();
    expect(settings.unattended?.deny).toEqual(["aws", "flyctl"]);
    expect(settings.unattended?.allowedDomains).toBeNull();

    pointerClick(screen.getByRole("button", { name: "Reset to defaults" }));
    await macrotask();
    expect(settings.unattended?.deny).toBeNull();
    expect(deny.value).toBe("aws\nkubectl");
  });
});

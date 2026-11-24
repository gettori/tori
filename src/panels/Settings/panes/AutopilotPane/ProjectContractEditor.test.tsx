import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { invoke } from "@tauri-apps/api/core";
import { render, screen, fireEvent, waitFor, within } from "../../../../test/harness";
import { DEFAULT_CONTRACT, type Contract } from "../../../../utils/autopilotContracts";
import ProjectContractEditor from "./ProjectContractEditor";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
const invoked = vi.mocked(invoke);

const local: Contract = { ...DEFAULT_CONTRACT, ships: "local" };
let contracts: () => Promise<Record<string, Contract>> = async () => ({ "/s/tori": local });

function hold() {
  let resolve!: (value: Record<string, Contract>) => void;
  const promise = new Promise<Record<string, Contract>>((yes) => (resolve = yes));
  return { promise, resolve };
}

const pressed = (option: string) =>
  within(screen.getByLabelText("How work ships")).getByRole("button", { name: option }).getAttribute("aria-pressed");
const reads = () => invoked.mock.calls.filter(([cmd]) => cmd === "autopilot_contracts").length;

beforeEach(() => {
  invoked.mockReset();
  contracts = async () => ({ "/s/tori": local });
  invoked.mockImplementation(async (cmd, args) => {
    if (cmd === "autopilot_contracts") return contracts();
    if (cmd === "autopilot_project_set") {
      const { patch } = args as { patch: Partial<Contract> };
      return { ...local, ...patch };
    }
    return null;
  });
});

describe("the project's autopilot contract", () => {
  it("says it is reading until the contracts land, then shows this project's", async () => {
    const first = hold();
    contracts = () => first.promise;
    render(() => <ProjectContractEditor project="/s/tori" />);
    expect(await screen.findByText("Reading the autopilot settings...")).toBeTruthy();
    expect(screen.queryByLabelText("How work ships")).toBeNull();

    first.resolve({ "/s/tori": local });
    await waitFor(() => expect(pressed("Local branch only")).toBe("true"));
  });

  it("shows what a save answered without reading the contracts again", async () => {
    render(() => <ProjectContractEditor project="/s/tori" />);
    await waitFor(() => expect(pressed("Local branch only")).toBe("true"));

    fireEvent.click(within(screen.getByLabelText("How work ships")).getByRole("button", { name: "Pull request" }));
    await waitFor(() => expect(pressed("Pull request")).toBe("true"));
    expect(reads()).toBe(1);
    expect(screen.queryByText("Reading the autopilot settings...")).toBeNull();
  });

  it("says the contracts could not be read instead of showing defaults, and tries again", async () => {
    contracts = () => Promise.reject("contracts file is not TOML");
    render(() => <ProjectContractEditor project="/s/tori" />);
    expect(await screen.findByText(/could not be read: contracts file is not TOML/)).toBeTruthy();
    expect(screen.queryByLabelText("How work ships")).toBeNull();

    contracts = async () => ({ "/s/tori": local });
    fireEvent.click(screen.getByText("Try again"));
    await waitFor(() => expect(pressed("Local branch only")).toBe("true"));
  });
});

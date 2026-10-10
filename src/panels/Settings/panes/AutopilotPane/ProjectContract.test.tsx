import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import ProjectContract from "./ProjectContract";
import { DEFAULT_CONTRACT, type Contract, type ContractPatch } from "../../../../utils/autopilotContracts";

const saved: Contract = {
  ...DEFAULT_CONTRACT,
  ships: "local",
  issues: [
    {
      repo: "gettori/tickets",
      labels: ["block 1"],
      exclude_labels: [],
      milestone: "Phase 1: Mac and Android",
      assignee: null,
      extra: null,
    },
  ],
};

// Stands in for Rust: a save lands in the contract, a bad repo is refused with its sentence.
function open(initial: Contract = DEFAULT_CONTRACT) {
  const [contract, setContract] = createSignal(initial);
  const onSet = vi.fn(async (patch: ContractPatch) => {
    if (patch.issues?.some((q) => !/^[^/\s]+\/[^/\s]+$/.test(q.repo)))
      throw `an issue source's repo must be owner/name, not "${patch.issues.find((q) => !q.repo.includes("/"))?.repo}"`;
    setContract((prev) => ({ ...prev, ...patch }));
  });
  render(() => (
    <ProjectContract project="/s/tori" contract={contract()} onSet={onSet} workersOn={() => <span>picker</span>} />
  ));
  return { onSet, setContract };
}

// Each choice is a segmented strip named after its question, so a choice is
// the button with the option's label inside that strip.
async function pick(name: string, option: string) {
  fireEvent.click(within(screen.getByLabelText(name)).getByRole("button", { name: option }));
}

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("ProjectContract", () => {
  it("saves each choice as its own patch", async () => {
    const { onSet } = open();
    await pick("How work ships", "Local branch only");
    await pick("How far it goes", "Alone until it leaves the machine");
    await pick("Picking up work", "Start on its own");
    expect(onSet.mock.calls.map((c) => c[0])).toEqual([
      { ships: "local" },
      { autonomy: "auto_until_outward" },
      { pickup: "auto" },
    ]);
  });

  it("adds a source, fills every field and saves the list", async () => {
    const { onSet } = open();
    expect(screen.getByText(/None: the issues assigned to you/)).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save sources" });
    expect(save.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    type("Source 1 repo", "gettori/tickets");
    type("Source 1 labels", "block 1, effort: easy");
    type("Source 1 exclude labels", "discuss");
    type("Source 1 milestone", "Phase 1: Mac and Android");
    type("Source 1 assignee", "any");
    type("Source 1 extra", "sort:created-asc");
    fireEvent.click(save);
    await waitFor(() =>
      expect(onSet).toHaveBeenCalledWith({
        issues: [
          {
            repo: "gettori/tickets",
            labels: ["block 1", "effort: easy"],
            exclude_labels: ["discuss"],
            milestone: "Phase 1: Mac and Android",
            assignee: "any",
            extra: "sort:created-asc",
          },
        ],
      }),
    );
    await waitFor(() => expect(save.hasAttribute("disabled")).toBe(true));
  });

  it("shows a saved contract, and removing its source saves an empty list", async () => {
    const { onSet } = open(saved);
    expect(
      within(screen.getByLabelText("How work ships"))
        .getByRole("button", { name: "Local branch only" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect((screen.getByLabelText("Source 1 repo") as HTMLInputElement).value).toBe("gettori/tickets");
    expect((screen.getByLabelText("Source 1 milestone") as HTMLInputElement).value).toBe("Phase 1: Mac and Android");
    fireEvent.click(screen.getByRole("button", { name: "Remove source" }));
    fireEvent.click(screen.getByRole("button", { name: "Save sources" }));
    await waitFor(() => expect(onSet).toHaveBeenCalledWith({ issues: [] }));
  });

  it("keeps a refused source as typed and says why", async () => {
    const { onSet } = open();
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    type("Source 1 repo", "gettori");
    fireEvent.click(screen.getByRole("button", { name: "Save sources" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain('must be owner/name, not "gettori"');
    expect(onSet).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("Source 1 repo") as HTMLInputElement).value).toBe("gettori");
  });
});

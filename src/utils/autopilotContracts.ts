// A project's autopilot contract, mirrored from `Contract` in
// `src-tauri/src/autopilot.rs`, and the two commands that read and set it.
import { invoke } from "@tauri-apps/api/core";

export type Ships = "pr" | "local";
export type Autonomy = "ask_everything" | "auto_until_outward";
export type Pickup = "ask" | "auto";

// `IssueQuery` in `src-tauri/src/issues`.
export type IssueQuery = {
  repo: string;
  labels: string[];
  exclude_labels: string[];
  milestone: string | null;
  assignee: string | null;
  extra: string | null;
};

export type Contract = {
  ships: Ships;
  autonomy: Autonomy;
  pickup: Pickup;
  agent: string | null;
  account: string | null;
  model: string | null;
  issues: IssueQuery[];
};

// A field left out keeps its value, but `issues` replaces the whole list.
export type ContractPatch = Partial<Omit<Contract, "issues">> & { issues?: IssueQuery[] };

export const DEFAULT_CONTRACT: Contract = {
  ships: "pr",
  autonomy: "ask_everything",
  pickup: "ask",
  agent: null,
  account: null,
  model: null,
  issues: [],
};

export const emptyQuery = (): IssueQuery => ({
  repo: "",
  labels: [],
  exclude_labels: [],
  milestone: null,
  assignee: null,
  extra: null,
});

const bare = (path: string) => path.replace(/\/+$/, "");

export const sameFolder = (a: string, b: string) => bare(a) === bare(b);

// Matched the way Rust keys it: one folder, however it is spelled.
export function contractFor(contracts: Record<string, Contract>, project: string): Contract {
  const found = Object.entries(contracts).find(([key]) => sameFolder(key, project));
  return found ? { ...DEFAULT_CONTRACT, ...found[1] } : DEFAULT_CONTRACT;
}

export const loadContracts = () => invoke<Record<string, Contract>>("autopilot_contracts");

// Rejects with the sentence Rust refused it with, such as a source whose repo is not `owner/name`.
export const setContract = (projectPath: string, patch: ContractPatch) =>
  invoke<Contract>("autopilot_project_set", { projectPath, patch });

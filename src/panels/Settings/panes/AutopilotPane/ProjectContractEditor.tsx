import { createDeferred, createMemo, createSignal, onCleanup, onSettled, refresh, Errored, Loading } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import ModelPicker from "../../../Chat/ModelPicker";
import { paletteProviders } from "../../../Chat/agentPaletteData";
import { probeOnHighlight, recheckAgent } from "../../../Chat/draftProbe";
import { settings } from "../../settingsStore";
import { openAgentCard } from "../../../../utils/agentCard";
import {
  agentReady,
  agentVersion,
  chatRuntimeMissing,
  ensureAgentHealthLoaded,
  namedProfiles,
  profileLabel,
  profileSignedOut,
} from "../../../../utils/agentHealth";
import { ensureAdaptersLoaded } from "../../../../utils/agents";
import { enabledChatAgents } from "../../../../utils/agentEnabled";
import { ensureModelCatalogsLoaded, isProbing, modelCatalogs } from "../../../../utils/modelCatalog";
import {
  contractFor,
  loadContracts,
  sameFolder,
  setContract,
  type Contract,
  type ContractPatch,
} from "../../../../utils/autopilotContracts";
import ProjectContract from "./ProjectContract";
import Button from "../../../../components/Button/Button";
import styles from "./ProjectContract.module.css";
import { issueRepos } from "../../../../utils/issues";
import { ISSUE_REPOS_CHANGED, onWith, type IssueReposChanged } from "../../../../utils/events";

/** One project's contract, read and saved through Rust, with the worker model
 *  picker wired to the agent catalogue. */
export default function ProjectContractEditor(props: { project: string; onDirty?: (dirty: boolean) => void }) {
  onSettled(() => {
    ensureAdaptersLoaded();
    ensureAgentHealthLoaded();
    void ensureModelCatalogsLoaded();
  });

  const providers = createMemo(() =>
    paletteProviders({
      adapters: enabledChatAgents(),
      catalogs: modelCatalogs(),
      profilesFor: namedProfiles,
      ready: agentReady,
      signedOut: profileSignedOut,
      probing: isProbing,
      chatRuntime: chatRuntimeMissing,
      version: agentVersion,
    }),
  );

  // Catches inside: an uncaught rejection would halt the reactive system.
  const repos = createDeferred<string[] | undefined>(
    (was) => {
      const path = props.project;
      if (!path) return was;
      return issueRepos(path)
        .then((r) => r.effective)
        .catch(() => undefined);
    },
    { loadingValue: undefined },
  );
  onCleanup(
    onWith<IssueReposChanged>(ISSUE_REPOS_CHANGED, (e) => {
      if (sameFolder(e.path, props.project)) void refresh(repos);
    }),
  );
  const loaded = createMemo(() => loadContracts());
  const [overrides, setOverrides] = createSignal<Record<string, Contract>>({});
  const contract = () => {
    const saved = overrides();
    const overridden = Object.keys(saved).some((key) => sameFolder(key, props.project));
    return contractFor(overridden ? saved : loaded(), props.project);
  };
  // Rust keys a project by the first spelling it saw, so any other spelling of this folder goes.
  const keep = (path: string, next: Contract) =>
    setOverrides((prev) => ({
      ...Object.fromEntries(Object.entries(prev).filter(([key]) => !sameFolder(key, path))),
      [path]: next,
    }));
  const setFor = (path: string) => (patch: ContractPatch) =>
    setContract(path, patch).then((saved) => keep(path, saved));
  // A save from anywhere (the other editor, an agent over the socket) is
  // published with the contract it left, so the open editor takes it as is.
  onSettled(() => {
    const unlisten = listen<{ kind?: string; project?: string; contract?: Contract }>("autopilot://changed", (e) => {
      const { kind, project, contract: saved } = e.payload ?? {};
      if (kind === "autopilot.changed" && project && saved) keep(project, saved);
    });
    return () => void unlisten.then((stop) => stop());
  });
  const workerAgent = () => contract().agent ?? settings.autopilot.agent;
  const workerModels = () =>
    providers().find((p) => p.agentId === workerAgent() && p.profile === contract().account)?.models ?? [];

  return (
    <Errored
      fallback={(err, reset) => (
        <p class={styles.error}>
          The autopilot settings could not be read: {String(err())}{" "}
          <Button size="xs" variant="ghost" onClick={() => reset()}>
            Try again
          </Button>
        </p>
      )}
    >
      <Loading fallback={<p class={styles.sourcesNote}>Reading the autopilot settings...</p>}>
        <ProjectContract
          project={props.project}
          onDirty={props.onDirty}
          contract={contract()}
          repos={repos() ?? []}
          onSet={setFor(props.project)}
          workersOn={(set) => (
            <ModelPicker
              models={workerModels()}
              providers={providers()}
              value={contract().model}
              agentId={workerAgent()}
              profile={contract().account}
              profileLabel={profileLabel(workerAgent(), contract().account)}
              effort={null}
              modelPending={false}
              effortPending={false}
              disabled={false}
              onSelectModel={(agent, account, model) => set({ agent, account, model: model.value })}
              onSelectEffort={() => {}}
              onHighlightAgent={(agent, account) => probeOnHighlight(agent, account)}
              onRecheckAgent={(agent, account) => recheckAgent(agent, account)}
              onFixAgent={openAgentCard}
            />
          )}
        />
      </Loading>
    </Errored>
  );
}

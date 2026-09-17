import { Match, Show, Switch, createMemo, createSignal, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import Button from "../../components/Button/Button";
import { ACTIVATE_SPACE, TOAST, emitWith, type ActivateSpace, type ToastEvent } from "../../utils/events";
import { finishFirstRun, firstRunConfig, firstRunView, markIntroSeen, reloadFirstRunConfig } from "../../utils/firstRun";
import { badName, shortHome } from "../../utils/names";
import { createAgentsSetup } from "./agentsSetup";
import FirstRunShell, { StepRail, type RailStep } from "./FirstRunShell";
import { AGENTS_LEAD } from "./steps/AgentsStep";
import BaseFolderStep, { BASE_FOLDER_LEAD, rootSpaces } from "./steps/BaseFolderStep";
import ReadyStep, { readyLead, type ReadySummary } from "./steps/ReadyStep";
import SpaceStep, { SPACE_LEAD, type SpaceMode } from "./steps/SpaceStep";
import Intro, { SLIDES } from "./intro/Intro";
import styles from "./FirstRun.module.css";

type StepId = "agents" | "base" | "space" | "ready";
const ORDER: StepId[] = ["agents", "base", "space", "ready"];
const HEADING: Record<StepId, string> = { agents: "Agents", base: "Base folder", space: "Space", ready: "Ready" };

/**
 * The setup half of first run, wired to the backend: the shell draws it, the
 * store says whether it is up, and this owns which step is on screen and what
 * the user has answered so far.
 *
 * Every write goes through the same commands the sidebar uses (`set_root`,
 * `add_space`), each of which emits `config://changed`, so the sidebar behind
 * the modal is already current by the time Open Tori is pressed.
 */
export default function FirstRun() {
  const introThisSession = firstRunView() === "intro";
  const [page, setPage] = createSignal<"intro" | "setup">(introThisSession ? "intro" : "setup");
  const [slide, setSlide] = createSignal(0);
  const [step, setStep] = createSignal<StepId>("agents");
  // The furthest step reached, so the rail can go back but never ahead of
  // what the earlier steps have answered.
  const [reached, setReached] = createSignal(0);
  const [home, setHome] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [spaceMode, setSpaceMode] = createSignal<SpaceMode>("pick");
  const [picked, setPicked] = createSignal<string | null>(null);
  const [newName, setNewName] = createSignal("");
  const [created, setCreated] = createSignal<string | null>(null);
  const agentsSetup = createAgentsSetup({ home, onScreen: () => page() === "setup" && step() === "agents" });

  onMount(() => {
    homeDir()
      .then(setHome)
      .catch(() => {
        // Paths then show in full rather than folded to ~.
      });
  });

  const config = () => firstRunConfig();
  const root = () => config()?.roots[0] ?? null;
  const spaces = createMemo(() => rootSpaces(config()?.spaces ?? []));
  const spaceName = (): string | null => {
    const list = spaces();
    if (list.length === 0) return null;
    const chosen = picked();
    return list.some((s) => s.name === chosen) ? chosen : list[0].name;
  };
  const summary = (): ReadySummary | null => {
    const r = root();
    const s = spaceName();
    return r && s ? { root: r, space: { name: s, created: s === created() } } : null;
  };

  function fail(e: unknown) {
    emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" });
  }

  function go(next: StepId) {
    setStep(next);
    setReached((n) => Math.max(n, ORDER.indexOf(next)));
  }

  async function chooseFolder() {
    setBusy(true);
    try {
      const path = await invoke<string | null>("pick_folder");
      if (!path) return;
      await invoke("set_root", { path });
      await reloadFirstRunConfig();
      // A new root is a new set of spaces; whatever was picked under the old
      // one names nothing now.
      setPicked(null);
      setSpaceMode("pick");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  const creating = () => step() === "space" && (spaceMode() === "create" || spaces().length === 0);
  const canCreate = () => !busy() && !badName(newName());

  async function createSpace() {
    const r = root();
    if (!r || !canCreate()) return;
    const name = newName().trim();
    setBusy(true);
    try {
      await invoke("add_space", { root: r, name, icon: null, color: null });
      await reloadFirstRunConfig();
      setCreated(name);
      setPicked(name);
      setNewName("");
      setSpaceMode("pick");
      activate(name);
      go("ready");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  function activate(name: string) {
    emitWith<ActivateSpace>(ACTIVATE_SPACE, { name });
  }

  function continueFromSpace() {
    const s = spaceName();
    if (!s) return;
    activate(s);
    go("ready");
  }

  function endIntro() {
    void markIntroSeen();
    setPage("setup");
  }

  function backToIntro() {
    setSlide(SLIDES.length - 1);
    setPage("intro");
  }

  const steps = (): RailStep[] => [
    { id: "agents", label: "Agents", group: "setup", summary: agentsSetup.summary() },
    {
      id: "base",
      label: "Base folder",
      required: true,
      group: "setup",
      summary: root() ? shortHome(root()!, home()) : null,
    },
    { id: "space", label: "Space", required: true, group: "setup", summary: spaceName() },
    { id: "ready", label: "Ready", group: "setup" },
  ];

  const back = () => (
    <Button onClick={() => go(ORDER[Math.max(0, ORDER.indexOf(step()) - 1)])}>Back</Button>
  );

  return (
    <Show when={page() === "setup"} fallback={<Intro slide={slide()} onSlide={setSlide} onDone={endIntro} />}>
      <FirstRunShell
        title="Set up Tori"
        rail={
          <StepRail
            steps={steps()}
            current={step()}
            reachable={(id) => !agentsSetup.running() && ORDER.indexOf(id as StepId) <= reached()}
            onJump={(id) => setStep(id as StepId)}
          />
        }
        railFooter={
          <span class={styles.railNote}>Agents, base folder and space show on every launch until a space exists.</span>
        }
        heading={HEADING[step()]}
        required={step() === "base" || step() === "space"}
        lead={
          <Switch>
            <Match when={step() === "agents"}>{AGENTS_LEAD}</Match>
            <Match when={step() === "base"}>{BASE_FOLDER_LEAD}</Match>
            <Match when={step() === "space"}>{SPACE_LEAD}</Match>
            <Match when={summary()}>{(s) => readyLead(s())}</Match>
          </Switch>
        }
        footerLeft={
          <Switch>
            <Match when={step() === "agents"}>Not required. Tori opens without an agent.</Match>
            <Match when={step() === "base"}>Required. You can change it later in Settings.</Match>
            <Match when={step() === "space"}>Required. This is the last step before Tori can open.</Match>
            <Match when={step() === "ready"}>Nothing was sent anywhere.</Match>
          </Switch>
        }
        footerRight={
          <Switch>
            <Match when={step() === "agents"}>
              <Show when={introThisSession}>
                <Button disabled={agentsSetup.running()} onClick={backToIntro}>
                  Back
                </Button>
              </Show>
              <Button variant="primary" disabled={agentsSetup.running()} onClick={() => go("base")}>
                Continue
              </Button>
            </Match>
            <Match when={step() === "base"}>
              {back()}
              <Button variant="primary" disabled={!root() || busy()} onClick={() => go("space")}>
                Continue
              </Button>
            </Match>
            <Match when={step() === "space"}>
              {back()}
              <Button
                variant="primary"
                disabled={creating() ? !canCreate() : !spaceName() || busy()}
                onClick={() => (creating() ? void createSpace() : continueFromSpace())}
              >
                {creating() ? "Create space" : "Continue"}
              </Button>
            </Match>
            <Match when={step() === "ready"}>
              {back()}
              <Button variant="primary" onClick={() => finishFirstRun()}>
                Open Tori
              </Button>
            </Match>
          </Switch>
        }
      >
        <Switch>
          <Match when={step() === "agents"}>
            {agentsSetup.view()}
          </Match>
          <Match when={step() === "base"}>
            <BaseFolderStep root={root()} spaces={config()?.spaces ?? []} home={home()} busy={busy()} onChoose={() => void chooseFolder()} />
          </Match>
          <Match when={step() === "space" && root()}>
            {(r) => (
              <SpaceStep
                root={r()}
                spaces={spaces()}
                home={home()}
                mode={spaceMode()}
                onMode={setSpaceMode}
                selected={spaceName()}
                onSelect={setPicked}
                name={newName()}
                onName={setNewName}
                busy={busy()}
                onSubmit={() => void createSpace()}
              />
            )}
          </Match>
          <Match when={step() === "ready" && summary()}>{(s) => <ReadyStep summary={s()} home={home()} />}</Match>
        </Switch>
      </FirstRunShell>
    </Show>
  );
}

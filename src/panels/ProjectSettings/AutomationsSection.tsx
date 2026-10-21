import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { TriangleAlert } from "lucide-solid";
import Button from "../../components/Button/Button";
import CheckboxGroup, { type CheckboxOption } from "../../components/CheckboxGroup/CheckboxGroup";
import Icon from "../../components/Icon/Icon";
import Select, { type SelectOption } from "../../components/Select/Select";
import { enabledChatAgents } from "../../utils/agentEnabled";
import {
  agentReady,
  agentVersion,
  chatRuntimeMissing,
  ensureAgentHealthLoaded,
  namedProfiles,
  profileLabel,
  profileSignedOut,
} from "../../utils/agentHealth";
import { openAgentCard } from "../../utils/agentCard";
import { ensureAdaptersLoaded, findAdapter } from "../../utils/agents";
import { cachedModes, capabilitiesFor } from "../../utils/chatModels";
import { catalogFor, ensureModelCatalogsLoaded, isProbing, modelCatalogs } from "../../utils/modelCatalog";
import ModeSelector from "../Chat/ModeSelector";
import ModelPicker from "../Chat/ModelPicker";
import { paletteProviders } from "../Chat/agentPaletteData";
import { probeOnHighlight, recheckAgent } from "../Chat/draftProbe";
import { Stepper } from "../Settings/components/paneKit";
import {
  prRule,
  reviewRule,
  setPrRule,
  setReviewRule,
  type PrEvent,
  type PrRule,
  type ReviewRule,
} from "../Settings/settingsStore";
import { Row, Section } from "./Section";
import styles from "./ProjectSettingsDialog.module.css";

const ACTIONS: SelectOption[] = [
  { value: "off", label: "Nothing" },
  { value: "worktree", label: "Create a worktree" },
  { value: "review", label: "Create a worktree and review it" },
];

const PR_EVENTS: CheckboxOption[] = [
  { value: "changes_requested", label: "A review requests changes" },
  { value: "check_failed", label: "A check fails" },
  { value: "conflicting", label: "It conflicts with its base" },
];

function PrRuleSection(props: { projectPath: string }) {
  const rule = () => prRule(props.projectPath);
  const save = (patch: Partial<PrRule>) => void setPrRule(props.projectPath, patch);
  return (
    <Section heading="When a watched pull request needs work">
      <Row
        stack
        label="Hand it to the autopilot when"
        hint="Only for a pull request a chat watches, once that chat is closed. The autopilot gets the fix as work under this project's contract, in its own worktree, and nothing is pushed without you. Needs pull request watches and the autopilot on."
      >
        <CheckboxGroup
          options={PR_EVENTS}
          value={rule().on}
          onChange={(on) => save({ on: on as PrEvent[] })}
          aria-label="Hand it to the autopilot when"
        />
      </Row>
      <Show when={rule().on.length > 0}>
        <Row label="At most per hour" hint="Past this the rule pauses until you resume it in the Cockpit.">
          <Stepper
            value={rule().maxPerHour}
            min={1}
            max={20}
            onChange={(v) => save({ maxPerHour: v })}
            aria-label="Pull request rule, at most per hour"
          />
        </Row>
      </Show>
    </Section>
  );
}

const UNPICKED: Partial<ReviewRule> = { agent: null, account: null, model: null, effort: null, mode: null };

function ReviewRunsOn(props: { rule: ReviewRule; save: (patch: Partial<ReviewRule>) => void }) {
  onMount(() => {
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
  const agent = () => props.rule.agent ?? enabledChatAgents()[0]?.id ?? "";
  const models = () => providers().find((p) => p.agentId === agent() && p.profile === props.rule.account)?.models ?? [];
  const model = () => models().find((m) => m.value === props.rule.model) ?? null;
  const chat = () => findAdapter(agent()).chat ?? null;
  const modes = () =>
    capabilitiesFor(model(), chat(), cachedModes(catalogFor(agent(), props.rule.account), chat()).modes).modes;
  const permissive = () => !!modes().find((m) => m.id === props.rule.mode)?.permissive;
  const picked = () => Object.keys(UNPICKED).some((k) => props.rule[k as keyof ReviewRule] !== null);

  return (
    <>
      <Row
        label="Runs on"
        hint="Unset uses the project's usual agent and model, in the agent's read-only mode where it has one. A review already running keeps what it started on."
      >
        <ModelPicker
          models={models()}
          providers={providers()}
          value={props.rule.model}
          agentId={agent()}
          profile={props.rule.account}
          profileLabel={profileLabel(agent(), props.rule.account)}
          effort={props.rule.effort}
          modelPending={false}
          effortPending={false}
          disabled={false}
          onSelectModel={(id, account, picked) =>
            props.save({
              agent: id,
              account,
              model: picked.value,
              effort: picked.effortLevels.some((l) => l.level === props.rule.effort) ? props.rule.effort : null,
              mode: id === props.rule.agent ? props.rule.mode : null,
            })
          }
          onSelectEffort={(effort) => props.save({ effort })}
          onHighlightAgent={(id, account) => probeOnHighlight(id, account)}
          onRecheckAgent={(id, account) => recheckAgent(id, account)}
          onFixAgent={openAgentCard}
        />
        <Show when={modes().length > 0}>
          <ModeSelector
            mode={props.rule.mode}
            modes={modes()}
            pending={false}
            disabled={false}
            onSelect={(mode) => props.save({ agent: agent(), mode })}
          />
        </Show>
        <Show when={picked()}>
          <Button size="sm" onClick={() => props.save(UNPICKED)}>
            Reset
          </Button>
        </Show>
      </Row>
      <Show when={permissive()}>
        <div class={styles.warnCard} role="group" aria-label="Runs without asking">
          <Icon icon={TriangleAlert} />
          <div class={styles.warnText}>
            <span class={styles.warnTitle}>Runs without asking</span>
            <span class={styles.warnBody}>
              The review runs commands on the pull request's branch with nobody approving them, including its build
              scripts and tests. Text in the pull request can steer it. Pick this only for authors you trust.
            </span>
          </div>
        </div>
      </Show>
    </>
  );
}

export default function AutomationsSection(props: { projectPath: string }) {
  const rule = () => reviewRule(props.projectPath);
  const save = (patch: Partial<ReviewRule>) => void setReviewRule(props.projectPath, patch);
  const [paused, setPaused] = createSignal(false);
  const [defaultPrompt, setDefaultPrompt] = createSignal("");
  // A failed read keeps what was last known rather than hiding a pause.
  const read = () =>
    invoke<{ paused: boolean; defaultPrompt: string }>("review_rule_state", { projectPath: props.projectPath }).then(
      (s) => {
        setPaused(s.paused);
        setDefaultPrompt(s.defaultPrompt);
      },
      () => {},
    );
  onMount(() => {
    void read();
    const off = listen<string>("review-rule://changed", (e) => {
      if (e.payload === props.projectPath) void read();
    });
    onCleanup(() => void off.then((f) => f()));
  });
  const resume = async () => {
    await invoke("review_rule_resume", { projectPath: props.projectPath });
    await read();
  };

  return (
    <>
      <Section heading="When your review is requested">
        <Row
          label="Do"
          hint="For each pull request that asks for your review from now on, and again when it asks after a push. Nothing is posted to the pull request without you."
        >
          <Select
            options={ACTIONS}
            value={rule().action}
            onChange={(v) => save({ action: v as ReviewRule["action"] })}
            aria-label="When your review is requested"
          />
        </Row>
        <Show when={rule().action === "review"}>
          <Row stack label="Review prompt" hint="Empty runs the built-in prompt shown.">
            <textarea
              class={styles.textarea}
              aria-label="Review prompt"
              rows={8}
              placeholder={defaultPrompt()}
              value={rule().prompt ?? ""}
              onChange={(e) => save({ prompt: e.currentTarget.value.trim() || null })}
            />
          </Row>
          <ReviewRunsOn rule={rule()} save={save} />
        </Show>
        <Show when={rule().action !== "off"}>
          <Row label="At most per hour" hint="Past this the rule pauses until you resume it.">
            <Stepper
              value={rule().maxPerHour}
              min={1}
              max={50}
              onChange={(v) => save({ maxPerHour: v })}
              aria-label="At most per hour"
            />
          </Row>
        </Show>
        <Show when={paused()}>
          <Row label="Paused" hint="It reached its hourly limit. Requests that came in meanwhile are not acted on.">
            <Button onClick={() => void resume()}>Resume</Button>
          </Row>
        </Show>
      </Section>
      <PrRuleSection projectPath={props.projectPath} />
    </>
  );
}

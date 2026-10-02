import { createMemo, onMount } from "solid-js";
import { Group, Row, Stepper, idsIn, optionalNumber, setAutopilot, type PaneProps } from "../../components/paneKit";
import styles from "../../Settings.module.css";
import { settings } from "../../settingsStore";
import Switch from "../../../../components/Switch/Switch";
import ModelPicker from "../../../Chat/ModelPicker";
import { paletteProviders } from "../../../Chat/agentPaletteData";
import { probeAgent, probeOnHighlight, recheckAgent } from "../../../Chat/draftProbe";
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
import { setAutopilotAvailable } from "../../../../utils/autopilotStore";

// Whole, because Rust keeps it as a u32 and a fraction would fail the save.
const percent = (n: number | null) => (n === null ? null : Math.min(95, Math.round(n)));

export default function AutopilotPane(props: PaneProps) {
  onMount(() => {
    ensureAdaptersLoaded();
    ensureAgentHealthLoaded();
    void ensureModelCatalogsLoaded().then(() => probeAgent(agentId(), profile()));
  });

  const agentId = () => settings.autopilot.agent;
  const profile = () => settings.autopilot.profile;
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
  const models = () => providers().find((p) => p.agentId === agentId() && p.profile === profile())?.models ?? [];

  return (
    <Group {...props} title="Autopilot" ids={idsIn("autopilot")}>
      <Row {...props} id="autopilot-on" label="Enable autopilot">
        <Switch
          checked={settings.autopilot.available}
          onChange={setAutopilotAvailable}
          aria-label="Enable autopilot"
        />
      </Row>

      <Row {...props} id="autopilot-model" label="Autopilot model">
        <ModelPicker
          models={models()}
          providers={providers()}
          value={settings.autopilot.model}
          agentId={agentId()}
          profile={profile()}
          profileLabel={profileLabel(agentId(), profile())}
          effort={settings.autopilot.effort}
          modelPending={false}
          effortPending={false}
          disabled={!settings.autopilot.available}
          onSelectModel={(agent, profile, model) =>
            setAutopilot({
              agent,
              profile,
              model: model.value,
              effort: model.effortLevels.some((l) => l.level === settings.autopilot.effort)
                ? settings.autopilot.effort
                : null,
            })
          }
          onSelectEffort={(effort) => setAutopilot({ effort })}
          onHighlightAgent={(agent, profile) => probeOnHighlight(agent, profile)}
          onRecheckAgent={(agent, profile) => recheckAgent(agent, profile)}
          onFixAgent={openAgentCard}
        />
      </Row>

      <Row {...props} id="autopilot-stall" label="Worker stalled after">
        <Stepper
          value={settings.autopilot.stallMinutes}
          min={5}
          max={240}
          step={5}
          onChange={(stallMinutes) => setAutopilot({ stallMinutes })}
          aria-label="Worker stalled after"
        />
      </Row>

      <Row
        {...props}
        id="autopilot-workers"
        label="Workers at once"
        hint={
          settings.forge.enabled
            ? undefined
            : "Forge status is off, so issues and reviews assigned to you are not picked up."
        }
      >
        <Stepper
          value={settings.autopilot.maxWorkers}
          min={1}
          max={16}
          step={1}
          onChange={(maxWorkers) => setAutopilot({ maxWorkers })}
          aria-label="Workers at once"
        />
      </Row>

      <Row {...props} id="autopilot-compact" label="Compact at context">
        <input
          type="number"
          min="10"
          max="95"
          placeholder="agent decides"
          aria-label="Compact at context"
          class={`${styles.input} ${styles.numField}`}
          value={settings.autopilot.compactAt ?? ""}
          onChange={(e) => setAutopilot({ compactAt: percent(optionalNumber(e.currentTarget.value, 10)) })}
        />
      </Row>
    </Group>
  );
}

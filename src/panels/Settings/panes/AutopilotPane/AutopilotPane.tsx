import { createMemo, onMount } from "solid-js";
import { Group, Row, Stepper, idsIn, setAutopilot, type PaneProps } from "../../components/paneKit";
import { settings } from "../../settingsStore";
import Switch from "../../../../components/Switch/Switch";
import ModelPicker from "../../../Chat/ModelPicker";
import { paletteProviders } from "../../../Chat/agentPaletteData";
import { probeAgent, probeOnHighlight, recheckAgent } from "../../../Chat/draftProbe";
import { openAgentCard } from "../../../../utils/agentCard";
import {
  agentReady,
  agentVersion,
  ensureAgentHealthLoaded,
  namedProfiles,
  profileLabel,
  profileSignedOut,
} from "../../../../utils/agentHealth";
import { ensureAdaptersLoaded } from "../../../../utils/agents";
import { enabledChatAgents } from "../../../../utils/agentEnabled";
import { ensureModelCatalogsLoaded, isProbing, modelCatalogs } from "../../../../utils/modelCatalog";
import { runner, startAutopilot, stopAutopilot } from "../../../../utils/autopilotStore";

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
      version: agentVersion,
    }),
  );
  const models = () => providers().find((p) => p.agentId === agentId() && p.profile === profile())?.models ?? [];

  // The switch follows the runner rather than `settings.autopilot.enabled`: only
  // start and stop write that flag, so the store's copy can be stale.
  const on = () => runner().state !== "off";

  return (
    <Group {...props} title="Autopilot" ids={idsIn("autopilot")}>
      <Row {...props} id="autopilot-on" label="Run the autopilot">
        <Switch
          checked={on()}
          onChange={(next) => void (next ? startAutopilot() : stopAutopilot())}
          aria-label="Run the autopilot"
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
          disabled={false}
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
    </Group>
  );
}

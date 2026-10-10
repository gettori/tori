import { createEffect, createMemo, createSignal, For, on, Show, untrack } from "solid-js";

import Button from "../../components/Button/Button";
import Checkbox from "../../components/Checkbox/Checkbox";
import SegmentedControl from "../../components/SegmentedControl/SegmentedControl";
import { enabledChatAgents } from "../../utils/agentEnabled";
import { namedProfiles, profileLabel } from "../../utils/agentHealth";
import { findAdapter } from "../../utils/agents";
import { emitWith, TOAST, type ToastEvent } from "../../utils/events";
import { isUnderPath, sameCwd } from "../../utils/pathScope";
import { projectRows, rowLabel, setProjectRows, soleProfile } from "../../utils/projectAgents";
import type { SpaceProject } from "../../utils/topicMembers";
import { forgetChatPrefsUnder, settings, type AgentRow, type ChatPrefs } from "../Settings/settingsStore";
import ProjectContractEditor from "../Settings/panes/AutopilotPane/ProjectContractEditor";
import { Section } from "./Section";
import styles from "./ProjectSettingsDialog.module.css";
import own from "./AgentsSection.module.css";

type RuleRow = AgentRow & { key: string; label: string; name: string; account: string };

const rowKey = (r: AgentRow) => `${r.agent}:${r.profile}`;

function ruleRows(allowed: AgentRow[]): RuleRow[] {
  const offered: RuleRow[] = enabledChatAgents().flatMap((a) => {
    const named = namedProfiles(a.id);
    const rows = named.length
      ? named.map((p) => ({ agent: a.id, profile: p.id }))
      : [{ agent: a.id, profile: soleProfile(a.id) }];
    return rows.map((r) => ({
      ...r,
      key: rowKey(r),
      label: rowLabel(r.agent, r.profile),
      name: findAdapter(r.agent).label,
      account: profileLabel(r.agent, r.profile) ?? "",
    }));
  });
  // A row the project allows stays listed after its account or agent is gone,
  // so the rule it still enforces can be cleared.
  const gone = allowed
    .filter((r) => !offered.some((o) => o.key === rowKey(r)))
    .map((r) => ({
      ...r,
      key: rowKey(r),
      label: `${rowLabel(r.agent, r.profile)} (unavailable)`,
      name: rowLabel(r.agent, r.profile),
      account: "unavailable",
    }));
  return [...offered, ...gone];
}

type Mode = "every" | "only";

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1) || p;

const agentOf = (p: ChatPrefs) =>
  p.agent ? (p.profile ? rowLabel(p.agent, p.profile) : findAdapter(p.agent).label) : null;
const anyPick = (p: ChatPrefs) => !!(p.agent || p.model || p.effort || p.mode);

const toast = (message: string) => emitWith<ToastEvent>(TOAST, { message, kind: "error" });

/**
 * Which agents may start or resume a session in this project, and the chat
 * picks each of its worktrees remembers.
 *
 * **The two rule states are a mode, not an empty list.** Every mode saves an
 * empty set, which is what "no rule" has always been, and a project loaded with
 * an empty set opens in Every mode. Ticks survive the switch to Every and back,
 * so an accidental press costs nothing until Save.
 */
export default function AgentsSection(props: {
  project: SpaceProject;
  /** Whether a list here holds unsaved edits, by list name. */
  onDirty?: (list: string, dirty: boolean) => void;
}) {
  const allowed = () => projectRows(props.project.path);
  const rows = () => ruleRows(allowed());
  const [mode, setMode] = createSignal<Mode>("every");
  const [checked, setChecked] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);

  // Keyed on content: every settings save hands back a fresh array, and an
  // unrelated one (a chat remembering its model) must not wipe unsaved ticks.
  const storedKey = createMemo(() => allowed().map(rowKey).sort().join());
  const discard = () => {
    const stored = untrack(allowed);
    setMode(stored.length ? "only" : "every");
    setChecked(stored.map(rowKey));
  };
  createEffect(on(storedKey, discard));

  const only = () => mode() === "only";
  const isOn = (key: string) => checked().includes(key);
  const toggle = (key: string, on: boolean) => setChecked((now) => (on ? [...now, key] : now.filter((k) => k !== key)));
  const draft = (): AgentRow[] =>
    only()
      ? rows()
          .filter((r) => isOn(r.key))
          .map((r) => ({ agent: r.agent, profile: r.profile }))
      : [];
  const dirty = () => draft().map(rowKey).sort().join() !== storedKey();
  const canSave = () => dirty() && (!only() || checked().length > 0);
  createEffect(() => props.onDirty?.("allowed", dirty()));
  const summary = () => {
    if (!only()) return "Every agent allowed";
    if (!checked().length) return "Tick at least one agent";
    return `${checked().length} of ${rows().length} agents allowed`;
  };

  async function save() {
    if (!canSave() || busy()) return;
    setBusy(true);
    try {
      await setProjectRows(props.project.path, draft());
    } catch (e) {
      toast(String(e));
    } finally {
      setBusy(false);
    }
  }

  // Only worktrees still on disk: a key left by a removed one names a folder
  // nobody can open a chat in, though the reset still clears it.
  const remembered = () => {
    const units = props.project.branchUnits ?? [];
    return Object.entries(settings.chat ?? {})
      .filter(([k, p]) => isUnderPath(k, props.project.path) && anyPick(p))
      .filter(([k]) => units.some((u) => sameCwd(u.folderPath, k)))
      .sort(([a], [b]) => a.localeCompare(b));
  };
  const anyStored = () => Object.keys(settings.chat ?? {}).some((k) => isUnderPath(k, props.project.path));

  return (
    <>
      <Section heading="Allowed agents">
        <div class={styles.wide}>
          <SegmentedControl
            class={styles.modes}
            aria-label="Which agents are allowed"
            options={[
              { value: "every", label: "Every agent" },
              { value: "only", label: "Only selected" },
            ]}
            value={mode()}
            onChange={setMode}
          />
          <p class={styles.lede}>
            {only()
              ? "Only the agents you tick can start or resume a session in this project."
              : "Any agent you have configured can start a session here. Nothing to pick."}
          </p>
          {/* Drawn in both modes, inert in one, so what Only mode would ask is
              visible before the switch. Every box is `disabled` too, so the
              hidden subtree holds nothing the keyboard could land on. */}
          <div class={own.list} classList={{ [own.idle]: !only() }} aria-hidden={!only() || undefined}>
            <For each={rows()}>
              {(row) => (
                <Checkbox
                  class={`${own.row} ${only() && isOn(row.key) ? own.rowOn : ""}`.trim()}
                  checked={only() && isOn(row.key)}
                  disabled={!only()}
                  onChange={(on) => toggle(row.key, on)}
                  aria-label={row.label}
                  label={
                    <span class={own.label}>
                      <span class={own.name}>{row.name}</span>
                      <Show when={row.account}>
                        <span class={own.account}>{row.account}</span>
                      </Show>
                    </span>
                  }
                />
              )}
            </For>
          </div>
          <div class={styles.actions}>
            <span class={styles.actionHint}>
              {summary()}
              <Show when={dirty()}>
                <span class={styles.unsaved}>Unsaved changes</span>
              </Show>
            </span>
            <Show when={dirty()}>
              <Button disabled={busy()} onClick={discard}>
                Discard
              </Button>
            </Show>
            <Button variant="primary" disabled={!canSave() || busy()} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </div>
      </Section>

      <Section
        heading="Remembered per worktree"
        meta={
          <Button
            size="sm"
            disabled={!anyStored()}
            onClick={() => void forgetChatPrefsUnder(props.project.path).catch((e) => toast(String(e)))}
          >
            Forget all
          </Button>
        }
      >
        <Show
          when={remembered().length}
          fallback={<p class={styles.empty}>Nothing remembered yet. A new worktree starts on your defaults.</p>}
        >
          <div class={styles.table} role="table" aria-label="Remembered per worktree">
            <div class={styles.tableHead} role="row">
              <For each={["Worktree", "Agent", "Model", "Effort", "Mode"]}>
                {(h) => <span role="columnheader">{h}</span>}
              </For>
            </div>
            <For each={remembered()}>
              {([folder, picks]) => (
                <div class={styles.tableRow} role="row">
                  <span role="cell" class={styles.mono}>
                    {basename(folder)}
                  </span>
                  <span role="cell">{agentOf(picks) ?? "-"}</span>
                  <span role="cell">{picks.model ?? "-"}</span>
                  <span role="cell">{picks.effort ?? "-"}</span>
                  <span role="cell">{picks.mode ?? "-"}</span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Section>

      <Section
        heading="Autopilot contract"
        meta={
          <Show when={settings.autopilot.available}>
            <span class={styles.badgeOn}>Autopilot on</span>
          </Show>
        }
      >
        <Show
          when={settings.autopilot.available}
          fallback={
            <div class={styles.card}>
              <span class={styles.cardTitle}>Autopilot is off</span>
              <span class={styles.cardBody}>This project's contract shows here while autopilot is on.</span>
            </div>
          }
        >
          <ProjectContractEditor project={props.project.path} onDirty={(on) => props.onDirty?.("sources", on)} />
        </Show>
      </Section>
    </>
  );
}

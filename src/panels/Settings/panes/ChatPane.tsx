import {
  Group,
  Row,
  clamp,
  optionalNumber,
  setBudgets,
  setChatDefaults,
  setCheckpoints,
  type PaneProps,
} from "../paneKit";
import { settings, type DefaultSurface, type TranscriptDensity } from "../settingsStore";
import styles from "../Settings.module.css";

/**
 * Chat, in three groups.
 *
 * The `chat` and `checkpoints` catalogue sections both land here, regrouped by
 * the question each row answers rather than by the section it is filed under:
 * how a chat opens and reads, what stops it running away, and what it may cost.
 * Spending is the group the budgets fix in the data layer unblocked - the
 * ceilings were writable here before it and gone on the next read.
 *
 * The id lists are written out rather than derived from a section, because the
 * grouping cuts across two of them. `settingsPanel.test.tsx` checks that every
 * catalogue entry reaches exactly one row on screen, which is what would catch
 * one being dropped from all three lists.
 */
const SESSIONS = ["default-surface", "streaming", "transcript-density", "tool-output-lines", "show-hooks"];
const SAFETY = ["legacy-permission-gate", "approval-auto-deny", "checkpoints"];
const SPENDING = ["max-concurrent-chats", "session-budget", "project-budget", "context-budget"];

export default function ChatPane(props: PaneProps) {
  return (
    <>
      <Group {...props} title="Sessions" ids={SESSIONS}>
        <Row
          {...props}
          id="default-surface"
          label="Open sessions in"
          hint="Which surface a click on a session opens. The other one stays available from the split-button menu either way, and already-saved tabs reopen on the surface they were saved on."
        >
          <div class={styles.control}>
            <select
              class={styles.select}
              value={settings.chatDefaults.defaultSurface}
              onChange={(e) => setChatDefaults({ defaultSurface: e.currentTarget.value as DefaultSurface })}
            >
              <option value="chat">Chat</option>
              <option value="agent">Terminal (agent tab)</option>
            </select>
          </div>
        </Row>

        {/* No default model/effort/mode settings on purpose: a new chat opens on
            whatever the CLI itself would choose, and the composer's pickers
            change course mid-conversation. */}

        <Row {...props} id="streaming" label="Stream responses">
          <input
            type="checkbox"
            checked={settings.chatDefaults.streaming}
            onChange={(e) => setChatDefaults({ streaming: e.currentTarget.checked })}
          />
        </Row>

        <Row {...props} id="transcript-density" label="Transcript density">
          <div class={styles.control}>
            <select
              class={styles.select}
              value={settings.chatDefaults.density}
              onChange={(e) => setChatDefaults({ density: e.currentTarget.value as TranscriptDensity })}
            >
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </div>
        </Row>

        <Row
          {...props}
          id="tool-output-lines"
          label="Tool output lines"
          hint="Lines shown before a tool's output folds. 0 shows all of it."
        >
          <input
            type="number"
            min="0"
            max="500"
            class={`${styles.input} ${styles.num}`}
            value={settings.chatDefaults.toolOutputLines}
            onChange={(e) =>
              setChatDefaults({
                toolOutputLines: clamp(e.currentTarget.value, 0, 500, settings.chatDefaults.toolOutputLines),
              })
            }
          />
        </Row>

        <Row
          {...props}
          id="show-hooks"
          label="Show every hook event"
          hint="Off, the transcript shows a hook only when it fails; a hook that ran as configured is not news. On reveals every execution, Sway's own per-tool-call approval hook included."
        >
          <input
            type="checkbox"
            checked={settings.chatDefaults.showSwayHooks}
            onChange={(e) => setChatDefaults({ showSwayHooks: e.currentTarget.checked })}
          />
        </Row>
      </Group>

      <Group {...props} title="Safety" ids={SAFETY}>
        <Row
          {...props}
          id="legacy-permission-gate"
          label="Approve tool calls in Sway"
          hint="Off, the agent asks for permission in its own protocol, so its permission modes mean what they say. On restores Sway's own approvals and rules, which decide ahead of the agent. Applies from the next session, not the ones already open."
        >
          <input
            type="checkbox"
            checked={settings.chatDefaults.legacyPermissionGate}
            onChange={(e) => setChatDefaults({ legacyPermissionGate: e.currentTarget.checked })}
          />
        </Row>

        <Row
          {...props}
          id="approval-auto-deny"
          label="Auto-deny approvals after"
          hint="Seconds an unanswered tool approval waits before Sway denies it. Sway owns this timeout so it always fires before the harness's own."
        >
          <input
            type="number"
            min="5"
            max="3600"
            class={`${styles.input} ${styles.num}`}
            value={settings.chatDefaults.approvalAutoDenySecs}
            onChange={(e) =>
              setChatDefaults({
                approvalAutoDenySecs: clamp(
                  e.currentTarget.value,
                  5,
                  3600,
                  settings.chatDefaults.approvalAutoDenySecs,
                ),
              })
            }
          />
        </Row>

        <Row
          {...props}
          id="checkpoints"
          label="Snapshot on each prompt"
          hint="Lets a session's turns be diffed and reverted. Adds one git snapshot per prompt."
        >
          <input
            type="checkbox"
            checked={settings.checkpoints.enabled}
            onChange={(e) => setCheckpoints({ enabled: e.currentTarget.checked })}
          />
        </Row>
      </Group>

      <Group {...props} title="Spending" ids={SPENDING}>
        <Row
          {...props}
          id="max-concurrent-chats"
          label="Warn above"
          hint="Live chats at once before Sway says so. Each one is an agent process with its own token spend, and a chat left open in a background tab goes on costing whether or not it is being read. A warning, not a refusal: 0 turns it off."
        >
          <input
            type="number"
            min="0"
            max="50"
            class={`${styles.input} ${styles.num}`}
            value={settings.chatDefaults.maxConcurrentChats}
            onChange={(e) =>
              setChatDefaults({
                maxConcurrentChats: clamp(e.currentTarget.value, 0, 50, settings.chatDefaults.maxConcurrentChats),
              })
            }
          />
        </Row>

        <Row
          {...props}
          id="session-budget"
          label="Stop this chat after"
          hint="Dollars one chat may spend before it stops starting turns. The turn that crosses the limit is allowed to finish. Leave blank for no limit, which is the default."
        >
          <input
            type="number"
            min="0"
            step="0.5"
            placeholder="no limit"
            class={`${styles.input} ${styles.num}`}
            value={settings.budgets.sessionUsd ?? ""}
            onChange={(e) => setBudgets({ sessionUsd: optionalNumber(e.currentTarget.value, 0) })}
          />
        </Row>

        <Row
          {...props}
          id="project-budget"
          label="Stop this project after"
          hint="Dollars across every chat in one project. Two chats open on one repo spend one budget."
        >
          <input
            type="number"
            min="0"
            step="0.5"
            placeholder="no limit"
            class={`${styles.input} ${styles.num}`}
            value={settings.budgets.projectUsd ?? ""}
            onChange={(e) => setBudgets({ projectUsd: optionalNumber(e.currentTarget.value, 0) })}
          />
        </Row>

        <Row
          {...props}
          id="context-budget"
          label="Stop at context"
          hint="Percent of the model's context window. Unlike the money limits this one recovers on its own after a compaction."
        >
          <input
            type="number"
            min="1"
            max="100"
            placeholder="no limit"
            class={`${styles.input} ${styles.num}`}
            value={settings.budgets.contextPercent ?? ""}
            onChange={(e) => setBudgets({ contextPercent: optionalNumber(e.currentTarget.value, 1) })}
          />
        </Row>
      </Group>
    </>
  );
}

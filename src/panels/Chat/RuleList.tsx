import { For, Show, createSignal } from "solid-js";
import { X } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import Button from "../../components/Button/Button";
import { ruleLabel, ruleOriginNote, type RuleKind, type ScopedRule } from "../../utils/chatRules";
import styles from "./Chat.module.css";

/** Why there is nothing here for a harness with no tool-approval hook.
 *
 *  An explanation rather than an empty list or a dimmed form: "No rules for
 *  this chat" would be true of a session that simply has none yet, and a
 *  disabled Add button invites the user to work out why on their own. */
export const RULES_NEED_HOOKS =
  "This agent has no tool-approval hook, so Sway cannot pre-approve or restrict its tool calls. Whatever the agent asks for itself still applies.";

/**
 * What this chat runs without asking, and the way to take it back.
 *
 * Read from the compiled file the hook helper itself consults, so the list is
 * what is really in force rather than a second opinion about it. Removing an
 * entry rewrites that file, which is what makes the next matching call prompt
 * again.
 */
export default function RuleList(props: {
  rules: readonly ScopedRule[];
  /** The harness declares the `PreToolUse` bridge these rules ride. False
   *  replaces the whole control with [[RULES_NEED_HOOKS]], since every action
   *  here writes a file nothing would read. */
  hooks: boolean;
  onRemove: (rule: ScopedRule) => void;
  onRestrict: (tool: string, kind: RuleKind, glob: string) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [tool, setTool] = createSignal("");
  const [glob, setGlob] = createSignal("");
  const [kind, setKind] = createSignal<RuleKind>("ask");

  function submit(e: SubmitEvent) {
    e.preventDefault();
    const t = tool().trim();
    const g = glob().trim();
    // A restriction with no pattern is a restriction on the whole tool, which
    // is a legitimate thing to want; one with no tool is not addressable at all.
    if (!t) return;
    props.onRestrict(t, kind(), g);
    setTool("");
    setGlob("");
  }

  return (
    <div class={styles.rules}>
      {/* Gated in the JSX rather than by an early return in the body: props are
          getters, so a body-level `if` would freeze this at whatever the tier
          said when the panel mounted. The adapter can resolve after that, and a
          stuck branch would tell a hook-capable session it has none. */}
      <Show when={props.hooks} fallback={<div class={styles.rulesUnsupported}>{RULES_NEED_HOOKS}</div>}>
        <button
          type="button"
          class={styles.rulesToggle}
          onClick={() => setOpen(!open())}
        >
          {/* "rules" rather than "tools allowed", now that a rule can also be a
              restriction: counting restrictions as things allowed would be a
              plain lie about what the list contains. */}
          {props.rules.length
            ? `${props.rules.length} rule${props.rules.length > 1 ? "s" : ""} for this chat`
            : "No rules for this chat"}
        </button>
        <Show when={open() && props.rules.length}>
          <ul class={styles.rulesBody}>
            <For each={props.rules}>
              {(rule) => (
                <li class={styles.ruleRow}>
                  <span class={styles.ruleLabel} title={ruleOriginNote(rule) ?? undefined}>
                    {ruleLabel(rule)}
                  </span>
                  {/* A rule nobody remembers writing is worse than no rule, so a
                      learned one says so on the row rather than only on hover. */}
                  <Show when={ruleOriginNote(rule)}>
                    <span class={styles.ruleScope}>learned</span>
                  </Show>
                  <span class={styles.ruleScope}>{rule.scope === "project" ? "this project" : "this session"}</span>
                  <button
                    type="button"
                    class={styles.ruleRemove}
                    title={rule.kind === "allow" ? "Ask again next time" : "Drop this restriction"}
                    aria-label={`Remove the rule for ${ruleLabel(rule)}`}
                    onClick={() => props.onRemove(rule)}
                  >
                    <Icon icon={X} />
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
        {/* Restrictions are *written*, not clicked. An allow rule comes from a
            button on one specific call, so its scope is derived from that call;
            "never touch migrations" is a statement about a place in the tree that
            no single call can be read off. That asymmetry is why this is the one
            rule you type, and why it is the only one that takes a pattern. */}
        <Show when={open()}>
          <form class={styles.ruleAdd} onSubmit={submit}>
            <select
              class={styles.ruleKind}
              value={kind()}
              onChange={(e) => setKind(e.currentTarget.value as RuleKind)}
              aria-label="What the rule does"
            >
              <option value="ask">ask about</option>
              <option value="deny">never run</option>
            </select>
            <input
              class={styles.ruleInput}
              value={tool()}
              onInput={(e) => setTool(e.currentTarget.value)}
              placeholder="Tool, e.g. Write"
              aria-label="Tool"
            />
            <input
              class={styles.ruleInput}
              value={glob()}
              onInput={(e) => setGlob(e.currentTarget.value)}
              placeholder="Path glob, e.g. **/migrations/**"
              aria-label="Path glob, optional"
            />
            <Button size="sm" type="submit" disabled={!tool().trim()}>
              Add
            </Button>
          </form>
        </Show>
      </Show>
    </div>
  );
}

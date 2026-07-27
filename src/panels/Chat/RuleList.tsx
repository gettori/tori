import { For, Show, createSignal } from "solid-js";
import { X } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import { ruleLabel, type ScopedRule } from "../../utils/chatRules";
import styles from "./Chat.module.css";

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
  onRemove: (rule: ScopedRule) => void;
}) {
  const [open, setOpen] = createSignal(false);

  return (
    <div class={styles.rules}>
      <button
        type="button"
        class={styles.rulesToggle}
        disabled={!props.rules.length}
        onClick={() => setOpen(!open())}
      >
        {props.rules.length
          ? `${props.rules.length} tool${props.rules.length > 1 ? "s" : ""} allowed without asking`
          : "Nothing allowed without asking"}
      </button>
      <Show when={open() && props.rules.length}>
        <ul class={styles.rulesBody}>
          <For each={props.rules}>
            {(rule) => (
              <li class={styles.ruleRow}>
                <span class={styles.ruleLabel}>{ruleLabel(rule)}</span>
                <span class={styles.ruleScope}>{rule.scope === "project" ? "this project" : "this session"}</span>
                <button
                  type="button"
                  class={styles.ruleRemove}
                  title="Ask again next time"
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
    </div>
  );
}

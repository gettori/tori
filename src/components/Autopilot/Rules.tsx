import { For, Show } from "solid-js";
import Button from "../Button/Button";
import { SectionHead } from "./ShellParts";
import type { RuleCard } from "./autopilot";
import styles from "./DeckList.module.css";

export interface RulesProps {
  rules: RuleCard[];
  onResume?: (project: string) => void;
}

export default function Rules(props: RulesProps) {
  return (
    <Show when={props.rules.length}>
      <SectionHead label="Pull request rules" count={props.rules.length} />
      <For each={props.rules}>
        {(r) => (
          <div class={styles.row} data-paused={r.paused ? "true" : "false"}>
            <div class={styles.head}>
              <span class={styles.name}>{r.name}</span>
            </div>
            <span class={styles.what}>{r.on}</span>
            <div class={styles.foot}>
              <Show when={r.paused} fallback={<span class={styles.when}>{r.fired}</span>}>
                <span class={styles.paused}>paused at its hourly limit</span>
                <Button size="xs" variant="ghost" onClick={() => props.onResume?.(r.project)}>
                  Resume
                </Button>
              </Show>
              <Show when={r.paused}>
                <span class={styles.last}>{r.fired}</span>
              </Show>
            </div>
          </div>
        )}
      </For>
    </Show>
  );
}

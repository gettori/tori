import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Button from "../../components/Button/Button";
import Select, { type SelectOption } from "../../components/Select/Select";
import { Stepper } from "../Settings/components/paneKit";
import { reviewRule, setReviewRule, type ReviewRule } from "../Settings/settingsStore";
import { Row, Section } from "./Section";
import styles from "./ProjectSettingsDialog.module.css";

const ACTIONS: SelectOption[] = [
  { value: "off", label: "Nothing" },
  { value: "worktree", label: "Create a worktree" },
  { value: "review", label: "Create a worktree and review it" },
];

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
  );
}

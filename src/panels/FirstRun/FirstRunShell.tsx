import { For, Show, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { Check } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import OverlayScroll from "../../components/Scrollbar/OverlayScroll";
import { FOCUSABLE } from "../../utils/focusable";
import styles from "./FirstRun.module.css";

export type RailStep = {
  id: string;
  label: string;
  required?: boolean;
  summary?: string | null;
  group: "setup" | "once";
};

/**
 * The modal's frame: the scrim, the panel, the rail of steps, and the pane the
 * current step draws into. Hand-rolled on the Settings recipe rather than on
 * `Dialog`, because this one cannot be dismissed: before the gate is met there
 * is nothing behind it to go back to.
 */
export default function FirstRunShell(props: {
  title: string;
  steps: RailStep[];
  current: string;
  /** Which steps the rail may jump to. Everything before the current one, in
   *  practice: a later step's inputs depend on the earlier ones. */
  reachable: (id: string) => boolean;
  onJump: (id: string) => void;
  railFooter?: JSX.Element;
  heading: string;
  required?: boolean;
  lead: JSX.Element;
  footerLeft?: JSX.Element;
  footerRight: JSX.Element;
  onKeyDown?: (e: KeyboardEvent) => void;
  children: JSX.Element;
}) {
  let panelEl!: HTMLDivElement;

  onMount(() => panelEl.focus());

  const index = (id: string) => props.steps.findIndex((s) => s.id === id);
  const stateOf = (id: string): "done" | "current" | "pending" => {
    if (id === props.current) return "current";
    return index(id) < index(props.current) ? "done" : "pending";
  };

  function onPanelKeyDown(e: KeyboardEvent) {
    props.onKeyDown?.(e);
    if (e.key !== "Tab" || e.defaultPrevented) return;
    const items = [...panelEl.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const at = document.activeElement;
    if (e.shiftKey ? at === first || at === panelEl : at === last) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  }

  const groups = () => {
    const setup = props.steps.filter((s) => s.group === "setup");
    const once = props.steps.filter((s) => s.group === "once");
    return { setup, once };
  };

  const stepRow = (s: RailStep) => {
    const state = () => stateOf(s.id);
    const n = () => index(s.id) + 1;
    return (
      <button
        type="button"
        class={styles.step}
        classList={{ [styles.stepCurrent]: state() === "current" }}
        aria-current={state() === "current" ? "step" : undefined}
        disabled={!props.reachable(s.id) || state() === "current"}
        onClick={() => props.onJump(s.id)}
      >
        <span
          class={styles.num}
          classList={{ [styles.numCurrent]: state() === "current", [styles.numDone]: state() === "done" }}
          aria-hidden="true"
        >
          <Show when={state() === "done"} fallback={n()}>
            <Icon icon={Check} size={12} strokeWidth={2.5} />
          </Show>
        </span>
        <span class={styles.stepText}>
          <span class={styles.stepLabel}>
            {s.label}
            <Show when={s.required}>
              <span class={styles.required}>Required</span>
            </Show>
          </span>
          <Show when={s.summary}>
            <span class={styles.stepSummary}>{s.summary}</span>
          </Show>
        </span>
      </button>
    );
  };

  return (
    <Portal>
      <div class={styles.backdrop}>
        <div
          ref={panelEl}
          class={styles.panel}
          role="dialog"
          aria-modal="true"
          aria-label={props.title}
          tabindex="-1"
          onKeyDown={onPanelKeyDown}
        >
          <nav class={styles.rail} aria-label="Setup steps">
            <div class={styles.brand}>
              <span class={styles.brandMark} aria-hidden="true" />
              {props.title}
            </div>
            <div class={styles.railGroup}>Setup</div>
            <For each={groups().setup}>{stepRow}</For>
            <Show when={groups().once.length > 0}>
              <div class={styles.railGroup}>Once, after the gate</div>
              <For each={groups().once}>{stepRow}</For>
            </Show>
            <div class={styles.railSpacer} />
            <Show when={props.railFooter}>
              <div class={styles.railCopy}>{props.railFooter}</div>
            </Show>
          </nav>

          <div class={styles.pane}>
            <OverlayScroll class={styles.paneScroll} contentClass={styles.paneInner}>
              <h1 class={styles.heading}>
                {props.heading}
                <Show when={props.required}>
                  <span class={styles.required}>Required</span>
                </Show>
              </h1>
              <p class={styles.lead}>{props.lead}</p>
              <div class={styles.content}>{props.children}</div>
            </OverlayScroll>
            <div class={styles.footer}>
              <div>{props.footerLeft}</div>
              <div class={styles.footerActions}>{props.footerRight}</div>
            </div>
          </div>
        </div>
      </div>
    </Portal>
  );
}

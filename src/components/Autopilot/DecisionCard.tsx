import { Show } from "solid-js";
import { ArrowUpRight, Eye, GitMerge, GitPullRequest, MessageCircleQuestion, type LucideIcon } from "lucide-solid";
import Button from "../Button/Button";
import Icon from "../Icon/Icon";
import type { DecisionKind, Ref } from "./autopilot";
import styles from "./DecisionCard.module.css";

const KINDS: Record<DecisionKind, { label: string; icon: LucideIcon }> = {
  pr: { label: "PR", icon: GitPullRequest },
  review: { label: "Review", icon: Eye },
  merge: { label: "Merge", icon: GitMerge },
  question: { label: "Question from worker", icon: MessageCircleQuestion },
};

export interface DecisionCardProps {
  kind: DecisionKind;
  /** The ticket or PR number the decision is about. */
  refNumber?: Ref;
  /** A PR ref reads "PR #45", a ticket ref just "#123". */
  refKind?: "issue" | "pr";
  title: string;
  /** One line for an outward action; the worker's question for a question. */
  summary: string;
  age: string;
  /** Branch of the worker asking, for a question. */
  worker?: string;
  /** The autopilot's proposed answer, for a question. */
  suggestion?: string;
  /** Selected by J/K; shows the A and R key hints. */
  focused?: boolean;
  onApprove?: () => void;
  onEdit?: () => void;
  onReply?: () => void;
  onDismiss?: () => void;
  onOpenWorker?: () => void;
}

/** One decision the autopilot needs from the user: an outward action to
 *  approve, or a worker's question to answer. The action set is fixed per
 *  card so every decision can be cleared from the keyboard the same way. */
export default function DecisionCard(props: DecisionCardProps) {
  const kind = () => KINDS[props.kind];
  const isQuestion = () => props.kind === "question";
  const refText = () => `${props.refKind === "pr" ? "PR " : ""}#${props.refNumber}`;

  return (
    <article class={styles.card} data-focused={props.focused ? "true" : "false"} aria-label={props.refNumber === undefined ? kind().label : `${kind().label} ${refText()}`}>
      <header class={styles.head}>
        <span class={styles.kind}>
          <Icon icon={kind().icon} class={styles.kindIcon} />
          {kind().label}
        </span>
        <Show when={props.refNumber !== undefined}>
          <span class={styles.ref}>{refText()}</span>
        </Show>
        <span class={styles.title}>{props.title}</span>
        <span class={styles.age}>{props.age}</span>
      </header>

      <Show when={isQuestion()} fallback={<p class={styles.summary}>{props.summary}</p>}>
        <div class={styles.quote}>
          <div class={styles.asker}>
            <span class={styles.dot} />
            Worker
            <span class={styles.worker}>{props.worker}</span>
          </div>
          <p class={styles.question}>{props.summary}</p>
        </div>
        <Show when={props.suggestion}>
          <p class={styles.suggestion}>Suggested reply: {props.suggestion}</p>
        </Show>
      </Show>

      <div class={styles.actions}>
        <Button size="sm" variant="primary" onClick={() => props.onApprove?.()}>
          Approve
          <Show when={props.focused}>
            <kbd class={styles.hint}>A</kbd>
          </Show>
        </Button>
        <Button size="sm" onClick={() => props.onEdit?.()}>
          Edit
        </Button>
        <Button size="sm" onClick={() => props.onReply?.()}>
          Reply
          <Show when={props.focused}>
            <kbd class={styles.hint}>R</kbd>
          </Show>
        </Button>
        <Button size="sm" variant="ghost" onClick={() => props.onDismiss?.()}>
          Dismiss
        </Button>
        <Show when={isQuestion()}>
          <Button
            size="sm"
            variant="ghost"
            class={styles.openWorker}
            iconRight={<Icon icon={ArrowUpRight} class={styles.kindIcon} />}
            onClick={() => props.onOpenWorker?.()}
          >
            Open worker
          </Button>
        </Show>
      </div>
    </article>
  );
}

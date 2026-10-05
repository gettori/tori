import { For, Show, createMemo, createSignal, createUniqueId } from "solid-js";
import { createStore } from "solid-js/store";
import Button from "../../components/Button/Button";
import CheckboxGroup from "../../components/CheckboxGroup/CheckboxGroup";
import RadioGroup from "../../components/RadioGroup/RadioGroup";
import { answerable, type QuestionItem } from "./chatStore";
import type { ChatQuestion, QuestionAnswer } from "../../utils/chatTypes";
import styles from "./Chat.module.css";

/** What the user has entered for one question, before it is sent. */
type Draft = { picks: string[]; freeText: string };

/** A question is answered when something was picked *or* something was typed.
 *
 *  Not "picked and typed" and not "picked only": the free-text box is how a
 *  question gets an answer the agent never offered, which is the whole reason
 *  it is always present, and 17 of 411 measured results were exactly that. */
function answeredDraft(draft: Draft): boolean {
  return draft.picks.length > 0 || draft.freeText.trim().length > 0;
}

/** The preview attached to the option these picks chose, if it declared one.
 *
 *  Single-pick only, and that is not a simplification: the tool offers a
 *  preview only on a single-select question, so two picks have none to show
 *  and one has at most one. */
function previewFor(question: ChatQuestion, picks: string[]): string | null {
  if (picks.length !== 1) return null;
  return question.options.find((o) => o.label === picks[0])?.preview ?? null;
}

/** Picks confirmed against the record, never parsed out of it: a candidate is
 *  claimed only when the record holds the exact `"question"="candidate"` it
 *  would have produced. Measured on 541 answers: 526 confirm, the rest are
 *  free text and fall back to quoting the record. */
function recoveredPicks(record: string, question: ChatQuestion): string[] | null {
  const labels = question.options.map((o) => o.label);
  const candidates: string[][] = labels.map((label) => [label]);
  if (question.multiSelect) {
    // Ordered subsets, joined the way picks travel: option order, ", ".
    // Bounded, the tool caps a question at four options.
    for (let mask = 1; mask < 1 << labels.length; mask++) {
      const subset = labels.filter((_, at) => mask & (1 << at));
      if (subset.length > 1) candidates.push(subset);
    }
  }
  const hits = candidates.filter((picks) => record.includes(`"${question.question}"="${picks.join(", ")}"`));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * A question the agent asked, as a form the user can answer.
 *
 * **Inline in the transcript rather than a modal.** The question is about the
 * work above it, and a modal would cover the one thing that explains it.
 *
 * **No countdown, because there is no deadline.** Measured: the CLI imposes
 * none on this transport (417s held, zero frames after the ask) and Tori arms
 * none either. The only things that end an unanswered question are the user and
 * an explicit withdrawal, so a timer here would be an invention.
 *
 * **Three lives, told by the frame and a chip.** Active keeps the blocking
 * gold. Answered drops to the neutral border and shows the answer the way it
 * was given: the sent picks selected on the controls themselves, the free-text
 * box only where the answer used it. Closed without an answer says "Not
 * answered" and dims. Gold stays reserved for the card still waiting.
 *
 * **Every question gets a free-text box while the form is open.** The tool
 * always offers Other, and a box that has to be revealed reads as an escape
 * hatch rather than as an answer. Picks and typed text are not exclusive: a
 * multi-select question can take both, and they travel back joined into one
 * value. Once the card settles, an empty disabled box says nothing and goes.
 *
 * Replayed from history it is read only, which is not a mode this component
 * chooses: `history.rs` emits no `questionRequest`, so a replayed row has no
 * `requestId` and nothing to answer. The structured answer never reached this
 * client either, so the card confirms the record against the options it knows
 * (`recoveredPicks`) and selects what it can prove; only a record it cannot
 * confirm, a free-text answer, is quoted verbatim instead.
 */
export default function QuestionCard(props: {
  item: QuestionItem;
  /** Absent where nothing can be sent, which renders the read-only shape rather
   *  than a form whose Submit would do nothing. */
  onAnswer?: (answers: QuestionAnswer[]) => void;
  /** The subagent whose lane this card belongs to, set only while it is showing
   *  outside that lane. Same reason as [`ToolCallCard`]'s: an unanswered
   *  question surfaces in main so the stall is visible there. */
  inLane?: string | null;
  onOpenLane?: (agentId: string) => void;
}) {
  const titleId = createUniqueId();
  const [drafts, setDrafts] = createStore<Record<number, Draft>>({});
  const [sending, setSending] = createSignal(false);

  const draftAt = (i: number): Draft => drafts[i] ?? { picks: [], freeText: "" };
  const open = () => answerable(props.item) && props.onAnswer !== undefined;
  const ready = createMemo(() => props.item.questions.every((_, i) => answeredDraft(draftAt(i))));

  /** Answered wins: once `submitted` or `result` exists there is nothing left
   *  to send, whatever the request id still says. */
  const state = (): "active" | "answered" | "unanswered" =>
    props.item.submitted !== null || props.item.result !== null ? "answered" : open() ? "active" : "unanswered";

  /** One entry per question, null where the record confirmed nothing. */
  const recovered = createMemo(() => {
    const record = props.item.submitted === null ? props.item.result : null;
    if (record === null) return null;
    return props.item.questions.map((q) => recoveredPicks(record, q));
  });

  /** The record still worth quoting: one that exists, was not superseded by a
   *  live submit, and could not be fully confirmed into selections. */
  const recordToQuote = () => {
    if (props.item.submitted !== null) return null;
    const picks = recovered();
    if (picks !== null && picks.length > 0 && picks.every((p) => p !== null)) return null;
    return props.item.result;
  };

  function submit(e: Event) {
    e.preventDefault();
    // Guarded as well as disabled: Enter in the text box submits the form, and
    // a request that can only take one answer must not take a second.
    if (!ready() || sending() || !open()) return;
    setSending(true);
    props.onAnswer?.(
      props.item.questions.map((q, i) => {
        const draft = draftAt(i);
        const typed = draft.freeText.trim();
        return {
          question: q.question,
          picks: draft.picks,
          freeText: typed.length > 0 ? typed : null,
        } satisfies QuestionAnswer;
      }),
    );
  }

  return (
    <form
      classList={{
        [styles.question]: true,
        [styles.questionDone]: state() === "answered",
        [styles.questionClosed]: state() === "unanswered",
      }}
      aria-labelledby={titleId}
      onSubmit={submit}
    >
      <div class={styles.questionHead}>
        <span id={titleId} class={styles.questionTitle}>
          {props.item.questions.length === 1 ? "The agent asked a question" : "The agent asked some questions"}
        </span>
        {/* A subagent's question is about work the user did not ask for
            directly, so the row says whose it is rather than letting it read as
            the main agent's. The id itself stays off the line and out of a
            `title`: it is a hex handle nobody recognises, and hover text is the
            one place a keyboard user would never find it. */}
        <Show when={props.item.agentId !== null}>
          <Show
            when={props.inLane && props.onOpenLane}
            fallback={<span class={styles.questionAgent}>from a subagent</span>}
          >
            <button type="button" class={styles.toolLane} onClick={() => props.onOpenLane?.(props.inLane!)}>
              Read what this subagent is doing
            </button>
          </Show>
        </Show>
        {/* Said in words as well as by the frame: the border shift alone is too
            quiet to scan for, and no chip is what marks the card still open. */}
        <Show when={state() !== "active"}>
          <span class={styles.questionState}>{state() === "answered" ? "Answered" : "Not answered"}</span>
        </Show>
      </div>

      <For each={props.item.questions}>
        {(question, i) => {
          const otherId = createUniqueId();
          const draft = () => draftAt(i());
          // Same index `submit` built the answers in, so no matching by text.
          const sent = () => props.item.submitted?.[i()] ?? null;
          const picks = () => sent()?.picks ?? recovered()?.[i()] ?? draft().picks;
          const typed = () => {
            const s = sent();
            return s ? (s.freeText ?? "") : draft().freeText;
          };
          const options = () =>
            question.options.map((o) => ({
              value: o.label,
              label: o.label,
              description: o.description || undefined,
            }));
          return (
            <div class={styles.questionRow}>
              <Show
                when={question.multiSelect}
                fallback={
                  <RadioGroup
                    label={question.question}
                    options={options()}
                    value={picks()[0] ?? null}
                    onChange={(value) => setDrafts(i(), { ...draft(), picks: [value] })}
                    disabled={!open()}
                  />
                }
              >
                <CheckboxGroup
                  label={question.question}
                  options={options()}
                  value={picks()}
                  onChange={(picks) => setDrafts(i(), { ...draft(), picks })}
                  disabled={!open()}
                />
              </Show>

              {/* The chosen option's worked example, which is why it was
                  offered: it is what the answer echoes back to the agent. */}
              <Show when={previewFor(question, picks())}>
                {(preview) => <pre class={styles.questionPreview}>{preview()}</pre>}
              </Show>

              {/* Open: always there, the box is how an unoffered answer gets
                  in. Settled: only where the answer actually used it. */}
              <Show when={open() || typed().trim().length > 0}>
                <label class={styles.questionOtherLabel} for={otherId}>
                  Other
                </label>
                <textarea
                  id={otherId}
                  class={styles.questionOther}
                  rows="2"
                  disabled={!open()}
                  placeholder="Your own answer, if none of these fit."
                  value={typed()}
                  onInput={(e) => setDrafts(i(), { ...draft(), freeText: e.currentTarget.value })}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }}
                />
              </Show>
            </div>
          );
        }}
      </For>

      <Show when={open()}>
        <div class={styles.questionActions}>
          <Button type="submit" size="sm" variant="primary" disabled={!ready() || sending()}>
            Send answers
          </Button>
          {/* Says which of the two reasons Submit is off, because "disabled and
              I cannot tell why" is the failure this whole form exists to avoid. */}
          <Show when={!ready()}>
            <span class={styles.questionHint}>
              {props.item.questions.length === 1
                ? "Pick an option or write your own."
                : "Every question needs an answer: pick an option or write your own."}
            </span>
          </Show>
        </div>
      </Show>

      {/* The agent's record, quoted only where nothing better exists: a
          replayed answer the options could not confirm, free text mostly.
          Everywhere else the selected picks say it themselves. */}
      <Show when={recordToQuote()}>{(result) => <pre class={styles.questionRecord}>{result()}</pre>}</Show>
    </form>
  );
}

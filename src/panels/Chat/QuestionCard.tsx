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

/** The preview attached to the option this draft picked, if it declared one.
 *
 *  Single-pick only, and that is not a simplification: the tool offers a preview
 *  only on a single-select question, so a draft with two picks has none to show
 *  and a draft with one has at most one. */
function previewFor(question: ChatQuestion, draft: Draft): string | null {
  if (draft.picks.length !== 1) return null;
  return question.options.find((o) => o.label === draft.picks[0])?.preview ?? null;
}

/**
 * A question the agent asked, as a form the user can answer.
 *
 * **Inline in the transcript rather than a modal.** The question is about the
 * work above it, and a modal would cover the one thing that explains it.
 *
 * **No countdown, because there is no deadline.** Measured: the CLI imposes
 * none on this transport (417s held, zero frames after the ask) and Sway arms
 * none either. The only things that end an unanswered question are the user and
 * an explicit withdrawal, so a timer here would be an invention.
 *
 * **Every question gets a free-text box, always visible.** The tool always
 * offers Other, and a box that has to be revealed reads as an escape hatch
 * rather than as an answer. Picks and typed text are not exclusive: a
 * multi-select question can take both, and they travel back joined into one
 * value.
 *
 * Replayed from history it is read only, which is not a mode this component
 * chooses: `history.rs` emits no `questionRequest`, so a replayed row has no
 * `requestId` and nothing to answer. It shows what was asked and the agent's own
 * record of the answer.
 */
export default function QuestionCard(props: {
  item: QuestionItem;
  /** Absent where nothing can be sent, which renders the read-only shape rather
   *  than a form whose Submit would do nothing. */
  onAnswer?: (answers: QuestionAnswer[]) => void;
}) {
  const titleId = createUniqueId();
  const [drafts, setDrafts] = createStore<Record<number, Draft>>({});
  const [sending, setSending] = createSignal(false);

  const draftAt = (i: number): Draft => drafts[i] ?? { picks: [], freeText: "" };
  const open = () => answerable(props.item) && props.onAnswer !== undefined;
  const ready = createMemo(() => props.item.questions.every((_, i) => answeredDraft(draftAt(i))));

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
    <form class={styles.question} aria-labelledby={titleId} onSubmit={submit}>
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
          <span class={styles.questionAgent}>from a subagent</span>
        </Show>
      </div>

      <For each={props.item.questions}>
        {(question, i) => {
          const otherId = createUniqueId();
          const draft = () => draftAt(i());
          const options = () =>
            question.options.map((o) => ({
              value: o.label,
              label: o.label,
              description: o.description || undefined,
            }));
          return (
            <div class={styles.questionRow}>
              <Show when={question.multiSelect} fallback={
                <RadioGroup
                  label={question.question}
                  options={options()}
                  value={draft().picks[0] ?? null}
                  onChange={(value) => setDrafts(i(), { ...draft(), picks: [value] })}
                  disabled={!open()}
                />
              }>
                <CheckboxGroup
                  label={question.question}
                  options={options()}
                  value={draft().picks}
                  onChange={(picks) => setDrafts(i(), { ...draft(), picks })}
                  disabled={!open()}
                />
              </Show>

              {/* The chosen option's worked example, which is why it was
                  offered: it is what the answer echoes back to the agent. */}
              <Show when={previewFor(question, draft())}>
                {(preview) => <pre class={styles.questionPreview}>{preview()}</pre>}
              </Show>

              <label class={styles.questionOtherLabel} for={otherId}>
                Other
              </label>
              <textarea
                id={otherId}
                class={styles.questionOther}
                rows="2"
                disabled={!open()}
                placeholder="Your own answer, if none of these fit."
                value={draft().freeText}
                onInput={(e) => setDrafts(i(), { ...draft(), freeText: e.currentTarget.value })}
              />
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

      {/* The agent's own record of the answer, verbatim. Deliberately not parsed
          back into per-question picks: the value can carry the user's own words,
          quote characters included, so any inverse of that grammar is a guess,
          and a card guessing wrong about what was chosen is worse than one
          quoting the record. */}
      <Show when={props.item.result}>
        {(result) => (
          <div class={styles.questionAnswered}>
            <span class={styles.questionAnsweredLabel}>Answered</span>
            <pre class={styles.questionRecord}>{result()}</pre>
          </div>
        )}
      </Show>
    </form>
  );
}

import { For, Index, Match, Show, Switch, createSignal } from "solid-js";
import ApprovalDraft from "../../src/panels/Chat/ApprovalDraft";
import type { AskApproval } from "../../src/utils/socketAsks";
import type { ChatQuestion } from "../../src/utils/chatTypes";
import type { RemoteClient } from "./remote";
import styles from "./mobile.module.css";

export type PendingRow =
  | { kind: "question"; id: string; questions: ChatQuestion[] }
  | { kind: "permission"; id: string; tool: string; detail: string | null }
  | { kind: "ask"; id: string; session: string; text: string; options: string[]; approval?: AskApproval };

function QuestionCard(props: { row: Extract<PendingRow, { kind: "question" }>; send: (answer: string[]) => void }) {
  const [answers, setAnswers] = createSignal<string[]>(props.row.questions.map(() => ""));
  const set = (at: number, value: string) => setAnswers(answers().map((a, i) => (i === at ? value : a)));
  return (
    <div class={styles.card}>
      <Index each={props.row.questions}>
        {(q, at) => (
          <div class={styles.question}>
            <strong>{q().question}</strong>
            <div class={styles.choices}>
              <For each={q().options}>
                {(option) => (
                  <button
                    class={styles.choice}
                    aria-pressed={answers()[at] === option.label}
                    onClick={() => set(at, option.label)}
                  >
                    {option.label}
                  </button>
                )}
              </For>
            </div>
            <input
              class={styles.input}
              placeholder="Or type an answer"
              value={q().options.some((o) => o.label === answers()[at]) ? "" : answers()[at]}
              onInput={(e) => set(at, e.currentTarget.value)}
            />
          </div>
        )}
      </Index>
      <div class={styles.cardActions}>
        <button
          class={styles.primarySmall}
          disabled={answers().some((a) => !a.trim())}
          onClick={() => props.send(answers())}
        >
          Answer
        </button>
      </div>
    </div>
  );
}

function PermissionCard(props: { row: Extract<PendingRow, { kind: "permission" }>; send: (answer: string) => void }) {
  return (
    <div class={styles.card}>
      <strong>Allow {props.row.tool}?</strong>
      <Show when={props.row.detail}>{(detail) => <pre class={styles.detail}>{detail()}</pre>}</Show>
      <div class={styles.cardActions}>
        <button class={styles.secondary} onClick={() => props.send("deny")}>
          Deny
        </button>
        <button class={styles.primarySmall} onClick={() => props.send("allow")}>
          Allow once
        </button>
      </div>
    </div>
  );
}

function AskCard(props: { row: Extract<PendingRow, { kind: "ask" }>; here: string; send: (answer: string) => void }) {
  const [text, setText] = createSignal("");
  return (
    <div class={styles.card}>
      <Show when={props.row.session !== props.here}>
        <span class={styles.rowMeta}>A worker asks</span>
      </Show>
      <strong>{props.row.text}</strong>
      <Show when={props.row.approval}>{(approval) => <ApprovalDraft approval={approval()} />}</Show>
      <div class={styles.cardActions}>
        <For each={props.row.options}>
          {(option) => (
            <button
              class={option === "Approve" ? styles.primarySmall : styles.secondary}
              onClick={() => props.send(option)}
            >
              {option}
            </button>
          )}
        </For>
      </div>
      <Show when={!props.row.approval}>
        <div class={styles.cardActions}>
          <input
            class={styles.input}
            placeholder="Or type an answer"
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
          />
          <button class={styles.secondary} disabled={!text().trim()} onClick={() => props.send(text().trim())}>
            Send
          </button>
        </div>
      </Show>
    </div>
  );
}

export default function Pending(props: {
  client: RemoteClient;
  session: string;
  rows: PendingRow[];
  onSettled: () => void;
}) {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const answer = (id: string, method: string, params: unknown) => {
    if (busy()) return;
    setBusy(id);
    setError(null);
    props.client
      .request(method, params)
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        setBusy(null);
        props.onSettled();
      });
  };
  return (
    <Show when={props.rows.length > 0 || error()}>
      <div class={styles.pending} aria-busy={busy() !== null}>
        <Show when={error()}>{(e) => <p class={styles.error}>{e()}</p>}</Show>
        <For each={props.rows}>
          {(row) => {
            const native = (a: string | string[]) =>
              answer(row.id, "session.answer", { session: props.session, id: row.id, answer: a });
            return (
              <Switch>
                <Match when={row.kind === "question" && row}>{(q) => <QuestionCard row={q()} send={native} />}</Match>
                <Match when={row.kind === "permission" && row}>
                  {(p) => <PermissionCard row={p()} send={native} />}
                </Match>
                <Match when={row.kind === "ask" && row}>
                  {(ask) => (
                    <AskCard
                      row={ask()}
                      here={props.session}
                      send={(a) => answer(row.id, "ask.answer", { id: row.id, answer: a })}
                    />
                  )}
                </Match>
              </Switch>
            );
          }}
        </For>
      </div>
    </Show>
  );
}

import { For, Show, createEffect, createResource, createSignal } from "solid-js";
import { issueDraft, type Issue, type IssueRef } from "../../src/utils/issues";
import type { RemoteClient } from "./remote";
import type { Unit } from "./tree";
import styles from "./shell.module.css";

type Where = "here" | "worktree" | "issue" | "review";
type Agent = { id: string; label: string };
type Agents = { agents: Agent[]; remembered: { agent: string; account: string | null } | null };
type Account = { id: string; label: string; email: string | null };
type Assigned = { lists: { rows: IssueRef[] }[] };

export type Started = { id: string; agent: string; folder: string };

const WHERE_LABEL: Record<Where, string> = {
  here: "Here",
  worktree: "New worktree",
  issue: "From an issue",
  review: "Review a PR",
};

export default function NewSheet(props: {
  client: RemoteClient;
  unit: Unit;
  project: string | null;
  onStarted: (started: Started) => void;
  onDone: () => void;
}) {
  const [agents] = createResource(() => props.client.request<Agents>("agents.list", { folder: props.unit.folder }));
  const [agent, setAgent] = createSignal<string | null>(null);
  const [account, setAccount] = createSignal<string | null>(null);
  createEffect(() => {
    const listed = agents();
    if (!listed || agent() !== null) return;
    const kept = listed.remembered;
    setAgent(kept?.agent ?? listed.agents[0]?.id ?? null);
    setAccount(kept?.account ?? null);
  });
  const [accounts] = createResource(agent, (id) => props.client.request<Account[]>("accounts.list", { agent: id }));
  const [where, setWhere] = createSignal<Where>("here");
  const [branch, setBranch] = createSignal("");
  const [base, setBase] = createSignal("");
  const [picked, setPicked] = createSignal<IssueRef | null>(null);
  const [prompt, setPrompt] = createSignal("");
  const [background, setBackground] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const [assigned] = createResource(
    () => (where() === "issue" || where() === "review") && props.project,
    (project) => props.client.request<Assigned>("issues.assigned", { project }),
  );
  const rows = () => {
    const kind = where() === "issue" ? "issue" : "reviewRequest";
    return (assigned()?.lists ?? []).flatMap((l) => l.rows).filter((r) => r.kind === kind);
  };
  const wheres = (): Where[] => (props.project ? ["here", "worktree", "issue", "review"] : ["here"]);
  const ready = () => {
    if (busy() || agent() === null) return false;
    if (where() === "worktree") return branch().trim() !== "";
    if (where() === "issue" || where() === "review") return picked() !== null;
    return true;
  };

  const folderFor = async (): Promise<{ folder?: string; prompt: string }> => {
    const project = props.project ?? undefined;
    const typed = prompt().trim();
    const row = picked();
    if (where() === "issue" && row) {
      const issue = await props.client.request<Issue>("issues.get", { key: row.key, project });
      const made = await props.client.request<{ path: string }>("worktree.new", {
        project,
        branch: issue.suggestedBranch,
        issue: row.key,
      });
      return { folder: made.path, prompt: typed || issueDraft(issue) };
    }
    if (where() === "review" && row) {
      const made = await props.client.request<{ path: string }>("worktree.new", {
        project,
        pr: Number(row.key),
      });
      return { folder: made.path, prompt: typed };
    }
    return { folder: where() === "here" ? props.unit.folder : undefined, prompt: typed };
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const { folder, prompt: first } = await folderFor();
      const fresh = where() === "worktree";
      const started = await props.client.request<Started>("session.spawn", {
        agent: agent(),
        account: account() ?? undefined,
        folder,
        project: fresh ? (props.project ?? undefined) : undefined,
        new_worktree: fresh ? branch().trim() : undefined,
        from: fresh && base().trim() ? base().trim() : undefined,
        prompt: first || undefined,
        background: background() || undefined,
      });
      props.onStarted(started);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div class={styles.dim} onClick={() => props.onDone()} />
      <section class={styles.sheet} role="dialog" aria-label="New session">
        <span class={styles.grabber} />
        <header class={styles.sheetHead}>
          <span class={styles.sheetTitle}>New session</span>
          <button class={styles.done} disabled={!ready()} onClick={() => void start()}>
            {busy() ? "Starting" : "Start"}
          </button>
        </header>
        <div class={styles.sheetBody}>
          <Show when={error()}>
            <p class={styles.banner}>{error()}</p>
          </Show>

          <h2 class={styles.label}>Where</h2>
          <ul class={styles.group}>
            <For each={wheres()}>
              {(w) => (
                <li>
                  <button
                    class={`${styles.item} ${styles.setting}`}
                    aria-pressed={where() === w}
                    onClick={() => {
                      setWhere(w);
                      setPicked(null);
                    }}
                  >
                    <span class={styles.text}>{WHERE_LABEL[w]}</span>
                    <Show when={w === "here"}>
                      <span class={styles.value}>{props.unit.label}</span>
                    </Show>
                  </button>
                </li>
              )}
            </For>
          </ul>

          <Show when={where() === "worktree"}>
            <div class={styles.typedBody}>
              <label class={styles.field}>
                Branch
                <input class={styles.mono} value={branch()} onInput={(e) => setBranch(e.currentTarget.value)} />
              </label>
              <label class={styles.field}>
                From
                <input
                  class={styles.mono}
                  placeholder="the default branch"
                  value={base()}
                  onInput={(e) => setBase(e.currentTarget.value)}
                />
              </label>
            </div>
          </Show>

          <Show when={where() === "issue" || where() === "review"}>
            <ul class={styles.group}>
              <For
                each={rows()}
                fallback={
                  <li>
                    <p class={styles.footnote}>
                      {assigned.loading ? "Loading" : assigned.error ? String(assigned.error) : "Nothing assigned"}
                    </p>
                  </li>
                }
              >
                {(row) => (
                  <li>
                    <button class={styles.item} aria-pressed={picked()?.key === row.key} onClick={() => setPicked(row)}>
                      <span class={styles.text}>
                        <span class={styles.name}>{row.title}</span>
                        <span class={styles.meta}>{row.display}</span>
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>

          <h2 class={styles.label}>Agent</h2>
          <ul class={styles.group}>
            <For each={agents()?.agents ?? []}>
              {(a) => (
                <li>
                  <button
                    class={`${styles.item} ${styles.setting}`}
                    aria-pressed={agent() === a.id}
                    onClick={() => {
                      setAgent(a.id);
                      setAccount(null);
                    }}
                  >
                    <span class={styles.text}>{a.label}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>

          <Show when={(accounts() ?? []).length > 1}>
            <h2 class={styles.label}>Account</h2>
            <ul class={styles.group}>
              <For each={accounts()}>
                {(a) => (
                  <li>
                    <button
                      class={`${styles.item} ${styles.setting}`}
                      aria-pressed={account() === a.id}
                      onClick={() => setAccount(a.id)}
                    >
                      <span class={styles.text}>{a.label}</span>
                      <Show when={a.email}>
                        <span class={styles.value}>{a.email}</span>
                      </Show>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>

          <h2 class={styles.label}>First message</h2>
          <div class={styles.typedBody}>
            <label class={styles.field}>
              <textarea
                rows={4}
                placeholder={where() === "issue" ? "The issue's title and body" : "Optional"}
                value={prompt()}
                onInput={(e) => setPrompt(e.currentTarget.value)}
              />
            </label>
          </div>

          <ul class={styles.group}>
            <li>
              <div class={`${styles.item} ${styles.setting}`}>
                <span class={styles.text}>Run in background</span>
                <button
                  class={styles.toggle}
                  role="switch"
                  aria-checked={background()}
                  aria-label="Run in background"
                  onClick={() => setBackground(!background())}
                />
              </div>
            </li>
          </ul>
        </div>
      </section>
    </>
  );
}

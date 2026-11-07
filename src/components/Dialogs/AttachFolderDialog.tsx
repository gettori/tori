import { createEffect, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Ban, Folder, FolderInput, GitBranch, GitFork, type LucideIcon } from "lucide-solid";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import Icon from "../Icon/Icon";
import { shortHome } from "../../utils/names";
import styles from "./Dialogs.module.css";

const NAME_LABEL = "attach-folder-name-label";
// Under this a read is not worth a state of its own: the card would flash.
const READING_AFTER_MS = 300;

type Worktree = { branch: string | null; path: string };

export type Inspection = {
  path: string;
  name: string;
  layout:
    | { kind: "plain" }
    | { kind: "clone"; branch: string | null; branches: number; remote: string | null; worktrees: Worktree[] }
    | { kind: "bare"; worktrees: Worktree[] };
  refused?: string;
};

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const count = (n: number, one: string, many: string) => `${WORDS[n] ?? n} ${n === 1 ? one : many}`;

export function remoteLabel(url: string): string {
  return url
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):(?!\d)/, "$1/")
    .replace(/\.git$/, "");
}

function Card(props: { icon: LucideIcon; heading: string; description: string; children?: JSX.Element }) {
  return (
    <div class={styles.detectCard}>
      <span class={styles.detectIcon}>
        <Icon icon={props.icon} />
      </span>
      <div class={styles.detectText}>
        <div class={styles.detectTitle}>{props.heading}</div>
        <div class={styles.detectDescription}>{props.description}</div>
      </div>
      <Show when={props.children}>
        <div class={styles.detectExtras}>{props.children}</div>
      </Show>
    </div>
  );
}

export function LayoutCard(props: {
  layout: Inspection["layout"];
  tilde: (p: string) => string;
  root?: string | null;
}) {
  const layout = props.layout;
  const tilde = props.tilde;
  // A worktree inside the project's folder by its place there, since every row
  // would otherwise repeat the same root. One outside it keeps its full path.
  const where = (path: string) => {
    const root = props.root?.replace(/\/+$/, "");
    return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : tilde(path);
  };
  if (layout.kind === "clone")
    return (
      <Card
        icon={GitBranch}
        heading={`Git repository on ${layout.branch ?? "a detached HEAD"}`}
        description={`A clone with ${count(layout.branches, "local branch", "local branches")}. It appears with its branches and worktrees like any project.`}
      >
        <dl class={styles.detectGrid}>
          <Show when={layout.remote}>
            {(url) => (
              <>
                <dt>Remote</dt>
                <dd>{remoteLabel(url())}</dd>
              </>
            )}
          </Show>
          <dt>Worktrees</dt>
          <dd>
            {layout.worktrees.length === 0
              ? `none besides ${layout.branch ?? "the checkout"}`
              : count(layout.worktrees.length, "more", "more")}
          </dd>
        </dl>
      </Card>
    );
  if (layout.kind === "bare")
    return (
      <Card
        icon={GitFork}
        heading={`Bare repository with ${count(layout.worktrees.length, "worktree", "worktrees")}`}
        description={
          layout.worktrees.length === 0
            ? "It has no worktrees yet. Add one once it is attached."
            : layout.worktrees.length === 1
              ? "Its worktree is attached with it."
              : `All ${WORDS[layout.worktrees.length] ?? layout.worktrees.length} are attached with it.`
        }
      >
        <Show when={layout.worktrees.length > 0}>
          <ul class={styles.detectWorktrees}>
            <For each={layout.worktrees}>
              {(w) => (
                <li>
                  <Icon icon={GitBranch} />
                  <span class={styles.detectBranch}>{w.branch ?? "detached"}</span>
                  <span class={styles.detectPath} title={w.path}>
                    {where(w.path)}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Card>
    );
  return (
    <Card
      icon={Folder}
      heading="Plain folder"
      description="Not a git repository. Sessions run in this folder; there are no branches or worktrees to show."
    />
  );
}

export default function AttachFolderDialog(props: {
  path: string;
  home: string;
  onChange: () => Promise<string | null>;
  onDone: (path: string, warning?: string) => void;
  onCancel: () => void;
}) {
  const [path, setPath] = createSignal(props.path);
  const [found, setFound] = createSignal<Inspection | null>(null);
  const [reading, setReading] = createSignal(false);
  const [name, setName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  createEffect(
    on(path, (at) => {
      setFound(null);
      setError(null);
      const slow = setTimeout(() => setReading(true), READING_AFTER_MS);
      onCleanup(() => clearTimeout(slow));
      invoke<Inspection>("inspect_folder", { path: at })
        .then((f) => {
          if (path() !== at) return;
          setFound(f);
          setName(f.name);
        })
        .catch((e) => path() === at && setError(String(e)))
        .finally(() => {
          clearTimeout(slow);
          if (path() === at) setReading(false);
        });
    }),
  );

  const canAttach = () => !!found() && !found()!.refused && !busy() && name().trim().length > 0;

  async function change() {
    const next = await props.onChange();
    if (next) setPath(next);
  }

  async function attach() {
    if (!canAttach()) return;
    setBusy(true);
    setError(null);
    try {
      const done = await invoke<{ path: string; warning?: string }>("attach_folder", {
        path: path(),
        name: name().trim(),
      });
      props.onDone(done.path, done.warning);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  const tilde = (p: string) => shortHome(p, props.home);

  return (
    <Dialog
      open
      size="sheet"
      title="Attach folder"
      lead={
        <span class={styles.attachLead}>
          <Icon icon={FolderInput} />
        </span>
      }
      onClose={() => props.onCancel()}
      onKeyDown={(e) => {
        if (e.key === "Enter" && canAttach()) {
          e.preventDefault();
          void attach();
        }
      }}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button variant="primary" disabled={!canAttach()} onClick={() => void attach()}>
            {busy() ? "Attaching…" : "Attach"}
          </Button>
        </>
      }
    >
      <div class={styles.spaceForm}>
        <div class={styles.spaceField}>
          <div class={styles.spaceLabel}>Folder</div>
          <div class={styles.folderField}>
            <Icon icon={Folder} class={styles.folderFieldIcon} />
            <span class={styles.folderFieldPath} title={path()}>
              {tilde(path())}
            </span>
            <Button size="sm" onClick={() => void change()}>
              Change…
            </Button>
          </div>
        </div>

        <Show when={error()}>
          {(msg) => (
            <div class={styles.warning} role="alert">
              {msg()}
            </div>
          )}
        </Show>

        <Show when={reading()}>
          <div class={styles.detectCard} aria-live="polite">
            <div class={styles.detectDescription}>Reading folder…</div>
          </div>
        </Show>

        <Show when={found()}>
          {(f) => (
            <Show
              when={!f().refused}
              fallback={<Card icon={Ban} heading="Tori can't attach this folder" description={f().refused!} />}
            >
              <LayoutCard layout={f().layout} tilde={tilde} root={path()} />
            </Show>
          )}
        </Show>

        <div class={styles.spaceField}>
          <div class={styles.spaceLabel}>
            <span id={NAME_LABEL}>Name</span>
          </div>
          <input
            class={styles.spaceInput}
            aria-labelledby={NAME_LABEL}
            value={name()}
            placeholder={found()?.name ?? "name"}
            onInput={(e) => setName(e.currentTarget.value)}
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
          />
        </div>

        <p class={styles.attachFine}>
          Tori uses the folder where it is. Nothing is moved or copied, and detaching later leaves it untouched.
        </p>
      </div>
    </Dialog>
  );
}

import { createEffect, createMemo, createSignal, on, For, Show, type JSX } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { FileDown, Folder, FolderSymlink, Link2, Link2Off, RefreshCw, Trash2 } from "lucide-solid";

import { emitWith, TOAST, type ToastEvent } from "../../utils/events";
import Button from "../../components/Button/Button";
import IconButton from "../../components/IconButton/IconButton";
import Icon from "../../components/Icon/Icon";
import Tooltip from "../../components/Tooltip/Tooltip";
import OverlayScroll from "../../components/Scrollbar/OverlayScroll";
import ConfirmDialog from "../../components/Dialogs/ConfirmDialog";
import FileIcon from "../../seti/FileIcon";
import styles from "./SharedFilesView.module.css";

/** Mirrors `LinkState` in src-tauri/src/shared.rs. */
type LinkState = "linked" | "missing" | "shadowed";

type WorktreeLink = { path: string; state: LinkState };
type SharedEntry = { name: string; is_dir: boolean; links: WorktreeLink[] };
type Overview = { dir: string; exists: boolean; worktrees: string[]; entries: SharedEntry[] };

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1) || p;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type Ask = {
  title: string;
  message: string;
  confirmLabel: string;
  extra?: JSX.Element;
  run: () => void;
};

/** A folder has no extension to pick a glyph from, so it gets the one icon a
 *  folder ever gets; a file gets the tree's. */
function EntryIcon(props: { name: string; dir: boolean }) {
  return (
    <Show when={props.dir} fallback={<FileIcon name={props.name} />}>
      <Icon icon={Folder} />
    </Show>
  );
}

const STATE_WORD: Record<LinkState, string> = {
  linked: "Linked",
  missing: "Not here",
  shadowed: "Has its own",
};

const STATE_WHY: Record<LinkState, string> = {
  linked: "This worktree reads the shared copy.",
  missing: "This worktree was made before the file was shared, or the link was deleted.",
  shadowed: "This worktree has a file of its own by that name, which is never replaced.",
};

/**
 * The files every worktree of a container gets, as a page rather than a tree.
 *
 * The folder is a tree, but the thing worth seeing is not its contents: it is
 * where each entry did and did not land. Linking runs once, when a worktree is
 * created, so an entry added later never reaches the worktrees already on disk
 * and a file tree shows no sign of it. Each row answers that, and the button
 * beside it closes the gap.
 */
export default function SharedFilesView(props: { workspace: string }) {
  const [data, setData] = createSignal<Overview | null>(null);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal("");
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());
  const [ask, setAsk] = createSignal<Ask | null>(null);
  const [keepIn, setKeepIn] = createSignal("");

  // Which read is current: the strip reuses one component across tabs of a
  // kind, so an earlier container's answer can land after a later one's.
  let current = 0;

  async function load() {
    const mine = ++current;
    try {
      const read = await invoke<Overview>("shared_overview", { container: props.workspace });
      if (mine !== current) return;
      setData(read);
      setError("");
    } catch (e) {
      if (mine !== current) return;
      setData(null);
      setError(String(e));
    }
  }

  createEffect(on(() => props.workspace, () => void load()));

  function toast(message: string, kind?: ToastEvent["kind"]) {
    emitWith<ToastEvent>(TOAST, { message, kind });
  }

  /** Every mutation reloads: each one changes what the other rows may do, and
   *  the folder can also move under us from a worktree being created. */
  async function run(key: string, work: () => Promise<string>) {
    if (busy()) return;
    setBusy(key);
    try {
      toast(await work());
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy("");
      await load();
    }
  }

  function toggle(name: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  }

  const worktreeCount = () => data()?.worktrees.length ?? 0;
  const missingIn = (e: SharedEntry) => e.links.filter((l) => l.state === "missing").length;
  const linkedIn = (e: SharedEntry) => e.links.filter((l) => l.state === "linked").length;
  const gaps = createMemo(() => (data()?.entries ?? []).reduce((n, e) => n + missingIn(e), 0));

  function link(name: string) {
    void run(`link:${name}`, async () => {
      const n = await invoke<number>("shared_link", { container: props.workspace, name });
      return n ? `Linked into ${plural(n, "worktree")}.` : "Nothing to link.";
    });
  }

  function unlink(name: string, worktree: string) {
    void run(`unlink:${worktree}:${name}`, async () => {
      await invoke("shared_unlink", { container: props.workspace, worktree, name });
      return `${basename(worktree)} no longer has ${name}.`;
    });
  }

  /** Stop sharing without losing the file: it moves back into one worktree as a
   *  real file and the other links go. Which worktree is the whole question, so
   *  the confirmation asks it rather than picking. */
  function keep(e: SharedEntry) {
    const holders = e.links.filter((l) => l.state === "linked").map((l) => l.path);
    const target = holders[0] ?? data()?.worktrees[0];
    if (!target) return;
    setKeepIn(target);
    setAsk({
      title: `Stop sharing ${e.name}?`,
      message:
        `The ${e.is_dir ? "folder" : "file"} moves back into one worktree and becomes a normal ` +
        `${e.is_dir ? "folder" : "file"} there.` +
        (holders.length > 1 ? ` The other ${plural(holders.length - 1, "worktree")} lose it.` : "") +
        "\n\nIt stops being hidden from git in this project.",
      confirmLabel: "Move back",
      extra: (
        <label class={styles.pick}>
          Keep it in
          <select value={keepIn()} onChange={(ev) => setKeepIn(ev.currentTarget.value)}>
            <For each={holders.length ? holders : (data()?.worktrees ?? [])}>
              {(w) => <option value={w}>{basename(w)}</option>}
            </For>
          </select>
        </label>
      ),
      run: () =>
        void run(`keep:${e.name}`, async () => {
          const worktree = keepIn();
          await invoke("shared_keep_in", { container: props.workspace, worktree, name: e.name });
          return `${e.name} is a normal ${e.is_dir ? "folder" : "file"} in ${basename(worktree)} now.`;
        }),
    });
  }

  function remove(e: SharedEntry) {
    const n = linkedIn(e);
    setAsk({
      title: `Delete ${e.name} everywhere?`,
      message:
        `The ${e.is_dir ? "folder" : "file"} is deleted from the shared folder` +
        (n ? `, and the ${plural(n, "link")} pointing at it go with it.` : ".") +
        "\n\nA worktree holding its own copy keeps it.",
      confirmLabel: "Delete",
      run: () =>
        void run(`remove:${e.name}`, async () => {
          await invoke("shared_remove", { container: props.workspace, name: e.name });
          return `${e.name} is no longer shared.`;
        }),
    });
  }

  return (
    <div class={styles.page}>
      <div class={styles.topBar}>
        <Icon icon={FolderSymlink} />
        <span class={styles.title}>Shared in worktrees</span>
        <span class={styles.dir} title={data()?.dir ?? props.workspace}>
          {data()?.dir ?? props.workspace}
        </span>
        <span class={styles.spacer} />
        <IconButton
          size="sm"
          icon={<Icon icon={RefreshCw} />}
          tooltip="Refresh"
          onClick={() => void load()}
        />
      </div>

      {/* What the folder is, stated once. The name says what these files are;
          nothing but a sentence can say when they are linked. */}
      <p class={styles.lede}>
        Linked into every new worktree of this project. Git does not carry them, so this is where a
        local <code>.env</code> or an editor config lives.
      </p>

      <Show when={error()}>
        <div class={styles.error}>{error()}</div>
      </Show>

      <OverlayScroll class={styles.scroll}>
        <Show when={data()}>
          {(d) => (
            <>
              <div class={styles.sectionHead}>
                <h2 class={styles.sectionTitle}>Shared</h2>
                <span class={styles.count}>
                  {d().entries.length
                    ? `${plural(d().entries.length, "entry").replace("entrys", "entries")} across ${plural(worktreeCount(), "worktree")}`
                    : ""}
                </span>
                <span class={styles.spacer} />
                <Show when={gaps()}>
                  <span class={styles.warn}>{plural(gaps(), "link")} missing</span>
                </Show>
              </div>

              <Show
                when={d().entries.length}
                fallback={<p class={styles.empty}>Nothing is shared yet.</p>}
              >
                <For each={d().entries}>
                  {(e) => (
                    <div class={styles.entry}>
                      <div class={styles.row}>
                        <button
                          type="button"
                          class={styles.rowMain}
                          aria-expanded={open().has(e.name)}
                          onClick={() => toggle(e.name)}
                        >
                          <EntryIcon name={e.name} dir={e.is_dir} />
                          <span class={styles.name}>{e.name}</span>
                          <span
                            class={styles.where}
                            classList={{ [styles.whereWarn]: missingIn(e) > 0 }}
                          >
                            in {linkedIn(e)} of {worktreeCount()}
                          </span>
                        </button>
                        <span class={styles.rowEnd}>
                          <Show when={missingIn(e)}>
                            <Button
                              size="xs"
                              variant="ghost"
                              disabled={!!busy()}
                              onClick={() => link(e.name)}
                            >
                              Link the other {missingIn(e)}
                            </Button>
                          </Show>
                          <IconButton
                            size="xs"
                            icon={<Icon icon={FileDown} />}
                            disabled={!!busy()}
                            aria-label={`Stop sharing ${e.name}, keeping the file`}
                            tooltip="Stop sharing and move it back into one worktree"
                            onClick={() => keep(e)}
                          />
                          <IconButton
                            size="xs"
                            icon={<Icon icon={Trash2} />}
                            disabled={!!busy()}
                            aria-label={`Delete ${e.name}`}
                            tooltip="Delete it and every link to it"
                            onClick={() => remove(e)}
                          />
                        </span>
                      </div>

                      <Show when={open().has(e.name)}>
                        <ul class={styles.links}>
                          <For each={e.links}>
                            {(l) => (
                              <li class={styles.link} data-state={l.state}>
                                <span class={styles.dot} aria-hidden="true" />
                                <span class={styles.wtName}>{basename(l.path)}</span>
                                <Tooltip as="span" class={styles.state} label={STATE_WHY[l.state]}>
                                  {STATE_WORD[l.state]}
                                </Tooltip>
                                <span class={styles.spacer} />
                                <Show when={l.state === "missing"}>
                                  <IconButton
                                    size="xs"
                                    icon={<Icon icon={Link2} />}
                                    disabled={!!busy()}
                                    aria-label={`Link ${e.name} into ${basename(l.path)}`}
                                    tooltip="Link it here"
                                    onClick={() => link(e.name)}
                                  />
                                </Show>
                                <Show when={l.state === "linked"}>
                                  <IconButton
                                    size="xs"
                                    icon={<Icon icon={Link2Off} />}
                                    disabled={!!busy()}
                                    aria-label={`Unlink ${e.name} from ${basename(l.path)}`}
                                    tooltip="Drop the link here only"
                                    onClick={() => unlink(e.name, l.path)}
                                  />
                                </Show>
                              </li>
                            )}
                          </For>
                        </ul>
                      </Show>
                    </div>
                  )}
                </For>
              </Show>

            </>
          )}
        </Show>
      </OverlayScroll>

      <Show when={ask()}>
        {(a) => (
          <ConfirmDialog
            danger
            title={a().title}
            message={a().message}
            confirmLabel={a().confirmLabel}
            extra={a().extra}
            onConfirm={() => {
              const req = a();
              setAsk(null);
              req.run();
            }}
            onCancel={() => setAsk(null)}
          />
        )}
      </Show>
    </div>
  );
}

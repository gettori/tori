import { createEffect, createMemo, createSignal, on, For, Show, type JSX } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import {
  CircleAlert,
  CornerDownRight,
  Folder,
  FolderSymlink,
  GitBranch,
  Link,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from "lucide-solid";

import { emitWith, TOAST, type ToastEvent } from "../../utils/events";
import { rememberWorktreePrefs, worktreePrefs, type WorktreePrefs } from "../Settings/settingsStore";
import Button from "../../components/Button/Button";
import IconButton from "../../components/IconButton/IconButton";
import Icon from "../../components/Icon/Icon";
import OverlayScroll from "../../components/Scrollbar/OverlayScroll";
import Switch from "../../components/Switch/Switch";
import ConfirmDialog from "../../components/Dialogs/ConfirmDialog";
import FileIcon from "../../seti/FileIcon";
import styles from "./WorktreesSection.module.css";

/** Mirrors `LinkState` in src-tauri/src/shared.rs. */
type LinkState = "linked" | "missing" | "shadowed";

type WorktreeLink = { path: string; state: LinkState };
type SharedEntry = { name: string; is_dir: boolean; links: WorktreeLink[] };
type Overview = { dir: string; exists: boolean; worktrees: string[]; entries: SharedEntry[] };

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1) || p;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const entryCount = (n: number) => `${n} ${n === 1 ? "entry" : "entries"}`;

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
  missing: "Missing",
  shadowed: "Has its own copy",
};

/**
 * What every new worktree of a container gets: the setup command it runs, and
 * the files shared into it, as a section rather than a tree.
 *
 * The folder is a tree, but the thing worth seeing is not its contents: it is
 * where each entry did and did not land. Linking runs once, when a worktree is
 * created, so an entry added later never reaches the worktrees already on disk
 * and a file tree shows no sign of it. The rail says which entries have a gap,
 * and the pane beside it says which worktrees the gap is in.
 */
export default function WorktreesSection(props: { workspace: string }) {
  const [data, setData] = createSignal<Overview | null>(null);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal("");
  const [pick, setPick] = createSignal("");
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

  createEffect(
    on(
      () => props.workspace,
      () => void load(),
    ),
  );

  function toast(message: string, kind?: ToastEvent["kind"]) {
    emitWith<ToastEvent>(TOAST, { message, kind });
  }

  const setup = () => worktreePrefs(props.workspace);
  function saveSetup(patch: Partial<WorktreePrefs>) {
    rememberWorktreePrefs(props.workspace, patch).catch((e) => toast(String(e), "error"));
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

  const missingIn = (e: SharedEntry) => e.links.filter((l) => l.state === "missing").length;
  const linkedIn = (e: SharedEntry) => e.links.filter((l) => l.state === "linked").length;
  const ownIn = (e: SharedEntry) => e.links.filter((l) => l.state === "shadowed").length;
  const entries = () => data()?.entries ?? [];
  const incomplete = createMemo(() => entries().filter((e) => missingIn(e) > 0).length);

  /** The rail's pick, falling back to the first entry: a reload that drops the
   *  chosen name must land on something rather than an empty pane. */
  const chosen = createMemo(() => entries().find((e) => e.name === pick()) ?? entries()[0]);

  function link(name: string, worktree?: string) {
    void run(`link:${worktree ?? ""}:${name}`, async () => {
      const n = await invoke<number>("shared_link", {
        container: props.workspace,
        name,
        worktree: worktree ?? null,
      });
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

  function tally(e: SharedEntry) {
    const parts = [`${linkedIn(e)} linked`];
    if (missingIn(e)) parts.push(`${missingIn(e)} missing`);
    if (ownIn(e)) parts.push(`${ownIn(e)} own`);
    return parts.join(", ");
  }

  function stateNote(e: SharedEntry, l: WorktreeLink) {
    if (l.state === "linked") return `${basename(l.path)}/${e.name}`;
    if (l.state === "missing") return "no entry on disk";
    return "a file of its own, never replaced";
  }

  return (
    <div class={styles.page}>
      <section class={styles.setup}>
        <span class={styles.setupHead}>Setup command</span>
        <input
          type="text"
          class={styles.setupInput}
          aria-label="Setup command"
          value={setup().setupCommand}
          placeholder="pnpm install --frozen-lockfile --prefer-offline"
          onChange={(e) => saveSetup({ setupCommand: e.currentTarget.value.trim() })}
        />
        <Switch
          checked={setup().setupWait}
          onChange={(on) => saveSetup({ setupWait: on })}
          label="Agents started over the socket wait for it"
        />
        <p class={styles.lede}>
          Runs with <code>sh -c</code> in each worktree Tori creates here, with <code>TORI_PROJECT_ROOT</code> and{" "}
          <code>TORI_WORKTREE_PATH</code> set. A fork's pull request never runs it.
        </p>
      </section>

      <div class={styles.sharedHead}>
        <Icon icon={FolderSymlink} />
        <span class={styles.sharedTitle}>Shared files</span>
        <span class={styles.dir} title={data()?.dir ?? props.workspace}>
          {"\u200e" + (data()?.dir ?? props.workspace) + "\u200e"}
        </span>
        <span class={styles.spacer} />
        <IconButton size="sm" icon={<Icon icon={RefreshCw} />} tooltip="Refresh" onClick={() => void load()} />
      </div>

      <Show when={error()}>
        <div class={styles.error}>{error()}</div>
      </Show>

      <div class={styles.body}>
        <div class={styles.rail}>
          <div class={styles.railHead}>
            <div class={styles.counts}>
              <span class={styles.total}>{entryCount(entries().length)}</span>
              <Show when={incomplete()}>
                <span class={styles.warn}>{incomplete()} incomplete</span>
              </Show>
            </div>
            {/* The one thing nobody guesses, and the reason the pane beside
                this has anything to do. */}
            <p class={styles.lede}>
              Links are made when a worktree is created, so anything shared later needs linking in by hand.
            </p>
          </div>

          <OverlayScroll class={styles.railList}>
            <Show when={entries().length} fallback={<p class={styles.empty}>Nothing is shared yet.</p>}>
              <For each={entries()}>
                {(e) => (
                  <button
                    type="button"
                    class={styles.item}
                    classList={{ [styles.itemOn]: chosen()?.name === e.name }}
                    aria-current={chosen()?.name === e.name}
                    onClick={() => setPick(e.name)}
                  >
                    <span class={styles.itemTop}>
                      <EntryIcon name={e.name} dir={e.is_dir} />
                      <span class={styles.itemName}>
                        {e.name}
                        {e.is_dir ? "/" : ""}
                      </span>
                      <span class={styles.spacer} />
                      <Show when={missingIn(e)}>
                        <Icon icon={TriangleAlert} class={styles.missMark} aria-label="Missing from a worktree" />
                      </Show>
                    </span>
                    <span class={styles.itemFoot}>
                      <span class={styles.tally}>{tally(e)}</span>
                    </span>
                  </button>
                )}
              </For>
            </Show>
          </OverlayScroll>
        </div>

        <div class={styles.detail}>
          <Show
            when={chosen()}
            fallback={
              <p class={styles.blank}>
                Share a file by right-clicking it in the file tree. It is linked into every worktree from then on.
              </p>
            }
          >
            {(e) => (
              <>
                <div class={styles.detailHead}>
                  <div class={styles.detailTop}>
                    <span class={styles.detailName}>{e().name}</span>
                    <span class={styles.kind}>{e().is_dir ? "folder" : "file"}</span>
                    <span class={styles.spacer} />
                    <Show when={missingIn(e())}>
                      <Button size="sm" variant="primary" disabled={!!busy()} onClick={() => link(e().name)}>
                        Link into {plural(missingIn(e()), "worktree")}
                      </Button>
                    </Show>
                  </div>
                  <p class={styles.path}>
                    {data()?.dir}/{e().name}
                  </p>
                  <Show when={missingIn(e())}>
                    <p class={styles.note}>{plural(missingIn(e()), "worktree")} never received it, or lost the link.</p>
                  </Show>
                </div>

                <OverlayScroll class={styles.rows}>
                  <div class={styles.rowHead}>
                    <span class={styles.colWorktree}>Worktree</span>
                    <span class={styles.colState}>State</span>
                  </div>
                  <For each={e().links}>
                    {(l) => (
                      <div class={styles.row} data-state={l.state}>
                        <span class={styles.wt}>
                          <Icon icon={GitBranch} />
                          <span class={styles.wtName}>{basename(l.path)}</span>
                        </span>
                        <span class={styles.state}>
                          <Icon icon={l.state === "missing" ? CircleAlert : Link} />
                          <span class={styles.stateText}>
                            <span class={styles.stateWord}>{STATE_WORD[l.state]}</span>
                            <span class={styles.stateNote}>{stateNote(e(), l)}</span>
                          </span>
                        </span>
                        <span class={styles.rowEnd}>
                          <Show when={l.state === "missing"}>
                            <Button
                              size="xs"
                              disabled={!!busy()}
                              aria-label={`Link ${e().name} into ${basename(l.path)}`}
                              onClick={() => link(e().name, l.path)}
                            >
                              Link
                            </Button>
                          </Show>
                          <Show when={l.state === "linked"}>
                            <Button
                              size="xs"
                              disabled={!!busy()}
                              aria-label={`Unlink ${e().name} from ${basename(l.path)}`}
                              onClick={() => unlink(e().name, l.path)}
                            >
                              Unlink
                            </Button>
                          </Show>
                        </span>
                      </div>
                    )}
                  </For>
                </OverlayScroll>

                <div class={styles.footBar}>
                  <Button
                    size="sm"
                    icon={<Icon icon={CornerDownRight} />}
                    disabled={!!busy()}
                    onClick={() => keep(e())}
                  >
                    Stop sharing...
                  </Button>
                  <Button
                    size="sm"
                    class={styles.destructive}
                    icon={<Icon icon={Trash2} />}
                    disabled={!!busy()}
                    onClick={() => remove(e())}
                  >
                    Delete entry...
                  </Button>
                  <p class={styles.footNote}>
                    Stop sharing moves the real {e().is_dir ? "folder" : "file"} into one worktree you choose, and the
                    rest lose it. Delete removes it and every link.
                  </p>
                </div>
              </>
            )}
          </Show>
        </div>
      </div>

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

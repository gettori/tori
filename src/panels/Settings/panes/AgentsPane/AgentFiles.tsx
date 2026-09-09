import { For, Show, createResource, createSignal } from "solid-js";
import { ArrowUpRight, File, Folder, X } from "lucide-solid";
import { invoke } from "@tauri-apps/api/core";
import Button from "../../../../components/Button/Button";
import Icon from "../../../../components/Icon/Icon";
import Chevron from "../../../../components/Chevron/Chevron";
import ConfirmDialog from "../../../../components/Dialogs/ConfirmDialog";
import {
  COMPOSE_DRAFT,
  OPEN_IN_EDITOR,
  TOAST,
  emitWith,
  type ComposeDraft,
  type OpenInEditor,
  type ToastEvent,
} from "../../../../utils/events";
import { fileMentionBlocks } from "../../../../utils/chatCompose";
import styles from "../../Settings.module.css";

/** Mirrors `crate::agent_config::EntryState`. */
export type EntryState = "missing" | "present" | "symlink" | "dangling";

/** Mirrors `crate::agent_config::ChildView`. */
export type ChildView = {
  name: string;
  /** `null` for a child with no file to open: a folder whose declared file is
   *  not in it. The backend resolves this, because which file a child *is* is
   *  the row's `new_path` and that never crosses to the frontend. */
  path: string | null;
};

/** Mirrors `crate::agent_config::EntryView`. */
export type EntryView = {
  id: string;
  label: string;
  kind: "file" | "dir";
  path: string;
  state: EntryState;
  target: string | null;
  children: ChildView[];
  newNameHint: string | null;
};

/** Mirrors `crate::agent_config::ProfileFilesView`. */
export type ProfileFilesView = {
  profileId: string;
  label: string;
  home: string;
  entries: EntryView[];
};

/** Mirrors `crate::agent_config::ConfigFilesView`. */
export type ConfigFilesView = {
  adapterId: string;
  declared: boolean;
  profiles: ProfileFilesView[];
};

/** The one reason every editor-opening action here can be off, in the words the
 *  tooltip says. Shells and a Feature with no present member both have a
 *  Selection and no folder, and a tab has to land in a workspace. */
const NO_ROOT = "Select a project first";

function toast(message: string, kind: ToastEvent["kind"]) {
  emitWith<ToastEvent>(TOAST, { message, kind });
}

/** The row's own path, relative to the account home it was resolved against.
 *
 *  The absolute one is what every action uses and what the expanded body shows;
 *  up top it would be the same home repeated on six rows, which is noise around
 *  the one part that differs. Directories keep a trailing slash, because
 *  `commands/` and `commands` are a folder and a file to the eye. */
function relPath(e: EntryView, home: string): string {
  const prefix = home.endsWith("/") ? home : `${home}/`;
  const rel = e.path.startsWith(prefix) ? e.path.slice(prefix.length) : e.path;
  return e.kind === "dir" ? `${rel}/` : rel;
}

/** A link target short enough to sit on the row: its last two segments.
 *
 *  Two rather than one, because the leaf alone is where most of these land
 *  (`AGENTS.md`, `prompts`) and says nothing about which tree it came from. The
 *  full path is on the chip's tooltip and in the body, so nothing is only ever
 *  shown abbreviated. */
function shortTarget(target: string): string {
  const parts = target.split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

/** The right-hand column: what is at the path, or how much of it.
 *
 *  A directory answers with its size, because "on disk" about a folder is the
 *  least interesting true thing to say about it. The link fact is not here at
 *  all: it rides the chip beside the path, so a linked file still gets to say
 *  whether anything is actually there. */
function stateLine(e: EntryView): string {
  if (e.state === "missing") return "not created";
  if (e.state === "dangling") return "broken link";
  if (e.kind === "file") return "on disk";
  const n = e.children.length;
  return n === 1 ? "1 file" : `${n} files`;
}

function FileRow(props: {
  entry: EntryView;
  home: string;
  profileId: string;
  agentId: string;
  agentLabel: string;
  projectRoot: string | null;
  onChanged: () => void;
}) {
  const e = () => props.entry;
  const rooted = () => props.projectRoot !== null;
  const [open, setOpen] = createSignal(false);
  const [naming, setNaming] = createSignal(false);
  const [name, setName] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  /** The child a confirm is currently about. Never deleted from the chip
   *  directly: this takes a whole skill folder, and a stray click on a chip in
   *  a settings panel is not consent for that. */
  const [doomed, setDoomed] = createSignal<ChildView | null>(null);

  const there = () => e().state === "present" || e().state === "symlink";
  // A dir row always offers "New"; a file row offers it only while there is no
  // file, because the action creates the row's own path.
  const canCreate = () => e().state !== "dangling" && (e().kind === "dir" || !there());

  const openPath = (path: string) => {
    if (!rooted()) return;
    emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path });
  };

  const create = async () => {
    const typed = name().trim();
    if (e().kind === "dir" && !typed) return;
    setBusy(true);
    setError(null);
    try {
      const made = await invoke<string>("agent_config_new", {
        adapterId: props.agentId,
        profileId: props.profileId,
        entryId: e().id,
        name: typed,
      });
      setNaming(false);
      setName("");
      props.onChanged();
      openPath(made);
    } catch (err) {
      // On the row rather than in a toast: the name that failed is still in the
      // box beside it, and a toast would float away from the thing to fix.
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (child: ChildView) => {
    setDoomed(null);
    setError(null);
    try {
      await invoke("agent_config_delete", {
        adapterId: props.agentId,
        profileId: props.profileId,
        entryId: e().id,
        name: child.name,
      });
      props.onChanged();
    } catch (err) {
      setError(String(err));
    }
  };

  // The path plus a line naming the entry, never a sent message. The user reads
  // the draft and decides; Sway only opens the chat with the target attached.
  const draft = () => {
    if (!rooted()) return;
    emitWith<ComposeDraft>(COMPOSE_DRAFT, {
      blocks: [
        ...fileMentionBlocks(e().path, e().label),
        { type: "text", text: `\n\nWrite my ${props.agentLabel} ${e().label.toLowerCase()}.` },
      ],
    });
  };

  return (
    <li class={styles.fileRow}>
      {/* The whole header is the disclosure, so the hit area is the row and
          there is one control rather than a row of competing ones. Nothing on
          it opens a file: a folder has none to open, and a rule that holds for
          some rows is a rule nobody learns. */}
      <button
        type="button"
        class={styles.fileHead}
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <span class={styles.fileGlyph} aria-hidden="true">
          <Icon icon={e().kind === "dir" ? Folder : File} />
        </span>
        <span class={styles.fileLabel}>{e().label}</span>
        <span class={styles.filePath}>{relPath(e(), props.home)}</span>
        {/* Where a link goes, beside the path it stands in for. Separate from
            the state on the right, so a linked file still says whether there is
            anything at the other end. */}
        <Show when={e().target}>
          {(target) => (
            <span class={styles.fileLink} title={target()}>
              <Icon icon={ArrowUpRight} />
              {shortTarget(target())}
            </span>
          )}
        </Show>
        <span class={styles.fileState} data-state={e().state}>
          {stateLine(e())}
        </span>
        <Chevron open={open()} />
      </button>

      <Show when={open()}>
        <div class={styles.fileBody}>
          {/* The absolute path, once, where there is room for it. */}
          <div class={styles.fileFull}>{e().path}</div>

          <Show when={e().children.length > 0}>
            <div class={styles.fileKids}>
              <For each={e().children}>
                {(child) => (
                  <span class={styles.fileKid}>
                    <button
                      type="button"
                      class={styles.fileKidOpen}
                      disabled={!rooted() || child.path === null}
                      title={
                        child.path === null
                          ? `No ${e().label.toLowerCase()} file in ${child.name}`
                          : (rooted() ? undefined : NO_ROOT)
                      }
                      onClick={() => child.path && openPath(child.path)}
                    >
                      {child.name}
                    </button>
                    {/* Removing needs no project, unlike everything that opens
                        a tab: it touches disk and nothing else. */}
                    <button
                      type="button"
                      class={styles.fileKidDrop}
                      aria-label={`Remove ${child.name}`}
                      title={`Remove ${child.name}`}
                      onClick={() => setDoomed(child)}
                    >
                      <Icon icon={X} />
                    </button>
                  </span>
                )}
              </For>
            </div>
          </Show>

          <div class={styles.fileActions}>
            <Show when={canCreate()}>
              <Show
                when={naming() && e().kind === "dir"}
                fallback={
                  <Button
                    size="sm"
                    disabled={!rooted() || busy()}
                    tooltip={rooted() ? undefined : NO_ROOT}
                    tooltipWhenDisabled
                    onClick={() => (e().kind === "dir" ? setNaming(true) : void create())}
                  >
                    New
                  </Button>
                }
              >
                <input
                  class={styles.fileName}
                  value={name()}
                  placeholder={e().newNameHint ?? "name"}
                  aria-label={`New ${e().label} name`}
                  autofocus
                  onInput={(ev) => setName(ev.currentTarget.value)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") void create();
                    if (ev.key === "Escape") (setNaming(false), setError(null));
                  }}
                />
                <Button size="sm" disabled={busy()} onClick={() => void create()}>
                  Create
                </Button>
              </Show>
            </Show>

            {/* A folder has no single file to open, so only a file row offers
                it; a folder's children each carry their own opener above. */}
            <Show when={e().kind === "file" && there()}>
              <Button
                size="sm"
                variant="ghost"
                disabled={!rooted()}
                tooltip={rooted() ? undefined : NO_ROOT}
                tooltipWhenDisabled
                onClick={() => openPath(e().path)}
              >
                Open
              </Button>
            </Show>

            <Button
              size="sm"
              variant="ghost"
              disabled={!rooted()}
              tooltip={rooted() ? undefined : NO_ROOT}
              tooltipWhenDisabled
              onClick={() => draft()}
            >
              Write with an agent
            </Button>

            {/* Every state but `missing`: there is nothing to reveal until
                there is something at the path, and a dangling link is still an
                entry Finder can show. */}
            <Show when={e().state !== "missing"}>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void invoke("reveal_in_finder", { path: e().path }).catch((err) =>
                    toast(String(err), "error"),
                  )
                }
              >
                Reveal in Finder
              </Button>
            </Show>
          </div>

          <Show when={error()}>
            <div class={styles.fileError}>{error()}</div>
          </Show>
        </div>
      </Show>

      {/* The absolute path, in the question. A row can be a link into a
          dotfiles repo, so where this lands is the part worth reading before
          answering, and it is not derivable from the chip. */}
      <Show when={doomed()}>
        {(child) => (
          <ConfirmDialog
            danger
            title={`Remove ${child().name}?`}
            message={`This deletes ${e().path}/${child().name} from disk. It cannot be undone.`}
            confirmLabel="Remove"
            onConfirm={() => void remove(child())}
            onCancel={() => setDoomed(null)}
          />
        )}
      </Show>
    </li>
  );
}

/**
 * The files this agent reads out of its account homes: one account at a time,
 * named by which tab is lit, and one row per `[[config.entries]]` row of its
 * adapter.
 *
 * One at a time rather than a block per account down the page, which is what
 * the Models group above settled on for the same reason: the rows are the same
 * six for every account, so stacking them reads as repetition rather than as a
 * per-account answer.
 *
 * A sibling of `AgentAccounts` rather than more of `AgentDetail`, on the same
 * reasoning: the detail page is already long, and both of these are lists whose
 * rows own their own actions. An adapter that declares no `[config]` table says
 * so in one line instead of rendering an empty card, the same way an adapter
 * with no accounts table renders no account controls.
 */
export default function AgentFiles(props: {
  agentId: string;
  agentLabel: string;
  projectRoot: string | null;
  /** Bumped by the accounts list above when an account is added or removed.
   *  Part of the resource key rather than an effect, so the refetch is the
   *  same mechanism as switching agents. */
  accountsNonce?: number;
}) {
  // One string, not a tuple: a fresh array literal is a new identity on every
  // read, so an array key would refetch on any re-render of the page rather
  // than when the thing it names actually moved.
  const [view, { refetch }] = createResource(
    () => `${props.agentId}:${props.accountsNonce ?? 0}`,
    (key) => invoke<ConfigFilesView>("agent_config_files", { adapterId: key.split(":")[0] }),
  );

  const profiles = () => view()?.profiles ?? [];
  const [picked, setPicked] = createSignal<string | null>(null);
  /** The picked account while it is still there, the first otherwise, which is
   *  also what an account removed from under the tabs lands on. */
  const shown = () => profiles().find((p) => p.profileId === picked()) ?? profiles()[0];

  return (
    <Show when={view()}>
      {(v) => (
        <>
          <div class={styles.groupHead}>
            <span class={styles.groupTitle}>Files</span>
            <span class={styles.sectionRule} />
            {/* Only once there are two: one tab is a word for the only thing
                there is, and the home under it already names the account. */}
            <Show when={v().declared && profiles().length > 1}>
              <div class={styles.groupTabs}>
                <For each={profiles()}>
                  {(profile) => (
                    <button
                      type="button"
                      class={styles.groupTab}
                      aria-pressed={profile.profileId === shown()?.profileId}
                      onClick={() => setPicked(profile.profileId)}
                    >
                      {profile.label}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
          <Show
            when={v().declared}
            fallback={<div class={styles.cardMeta}>This adapter declares no files.</div>}
          >
            <Show when={shown()}>
              {(profile) => (
                <div class={styles.accountsCard}>
                  {/* The home, not the label: the tabs above already say which
                      account this is, and the path is the part that is not
                      guessable from the name. */}
                  <div class={styles.acctHead}>
                    <span class={styles.acctHome}>{profile().home}</span>
                  </div>
                  <ul class={styles.fileList}>
                    <For each={profile().entries}>
                      {(entry) => (
                        <FileRow
                          entry={entry}
                          home={profile().home}
                          profileId={profile().profileId}
                          agentId={props.agentId}
                          agentLabel={props.agentLabel}
                          projectRoot={props.projectRoot}
                          onChanged={() => void refetch()}
                        />
                      )}
                    </For>
                  </ul>
                </div>
              )}
            </Show>
          </Show>
        </>
      )}
    </Show>
  );
}

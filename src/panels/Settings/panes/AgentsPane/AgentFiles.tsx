import { For, Show, createResource, createSignal } from "solid-js";
import { FolderOpen, Plus } from "lucide-solid";
import { invoke } from "@tauri-apps/api/core";
import Button from "../../../../components/Button/Button";
import Icon from "../../../../components/Icon/Icon";
import IconButton from "../../../../components/IconButton/IconButton";
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

/** Mirrors `crate::agent_config::EntryView`. */
export type EntryView = {
  id: string;
  label: string;
  kind: "file" | "dir";
  path: string;
  state: EntryState;
  target: string | null;
  children: string[];
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

/** What the row says is at its path, right of the path itself.
 *
 *  The reader's words rather than the wire's four. A link says where it goes,
 *  because that is the whole reason to tell a link apart from a file, and a
 *  broken one says it in the words that make the row's disabled New make sense.
 */
function stateLine(e: EntryView): string {
  switch (e.state) {
    case "present":
      return "on disk";
    case "missing":
      return "not created";
    case "symlink":
      return `link -> ${e.target ?? "?"}`;
    case "dangling":
      return `broken link -> ${e.target ?? "?"}`;
  }
}

function FileRow(props: {
  entry: EntryView;
  profileId: string;
  agentId: string;
  agentLabel: string;
  projectRoot: string | null;
  onChanged: () => void;
}) {
  const e = () => props.entry;
  const rooted = () => props.projectRoot !== null;
  const [naming, setNaming] = createSignal(false);
  const [name, setName] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  // A dir row always offers "New"; a file row offers it only while there is no
  // file, because the action creates the row's own path.
  const canCreate = () =>
    e().state !== "dangling" && (e().kind === "dir" || e().state === "missing");

  const open = (path: string) => {
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
      open(made);
    } catch (err) {
      // On the row rather than in a toast: the name that failed is still in the
      // box beside it, and a toast would float away from the thing to fix.
      setError(String(err));
    } finally {
      setBusy(false);
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
      <div class={styles.fileMain}>
        <Show
          when={e().state !== "missing" && rooted()}
          fallback={<span class={styles.fileLabel}>{e().label}</span>}
        >
          <button type="button" class={styles.fileOpen} onClick={() => open(e().path)}>
            {e().label}
          </button>
        </Show>
        <span class={styles.filePath}>{e().path}</span>
        <span class={styles.fileState} data-state={e().state}>
          {stateLine(e())}
        </span>
      </div>

      {/* Immediate children only. A skills folder kept in a dotfiles repo reads
          as its skills rather than as an opaque link. */}
      <Show when={e().children.length > 0}>
        <ul class={styles.fileKids}>
          <For each={e().children}>
            {(child) => (
              <li>
                <button
                  type="button"
                  class={styles.fileOpen}
                  disabled={!rooted()}
                  title={rooted() ? undefined : NO_ROOT}
                  onClick={() => open(`${e().path}/${child}`)}
                >
                  {child}
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <div class={styles.fileActions}>
        <Show when={canCreate()}>
          <Show
            when={naming() && e().kind === "dir"}
            fallback={
              <Button
                size="sm"
                variant="ghost"
                icon={<Icon icon={Plus} />}
                disabled={!rooted() || busy()}
                tooltip={rooted() ? "New from blank" : NO_ROOT}
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
            <Button size="sm" variant="ghost" disabled={busy()} onClick={() => void create()}>
              Create
            </Button>
          </Show>
        </Show>

        {/* Every state but `missing`: there is nothing to reveal until there is
            something at the path, and a dangling link is still an entry Finder
            can show. */}
        <Show when={e().state !== "missing"}>
          <IconButton
            size="sm"
            icon={<Icon icon={FolderOpen} />}
            tooltip="Reveal in Finder"
            onClick={() =>
              void invoke("reveal_in_finder", { path: e().path }).catch((err) =>
                toast(String(err), "error"),
              )
            }
          />
        </Show>

        <Button
          size="sm"
          variant="ghost"
          disabled={!rooted()}
          tooltip={rooted() ? undefined : NO_ROOT}
          tooltipWhenDisabled
          onClick={() => draft()}
        >
          Write it with an agent
        </Button>
      </div>

      <Show when={error()}>
        <div class={styles.fileError}>{error()}</div>
      </Show>
    </li>
  );
}

/**
 * The files this agent reads out of each of its account homes, one sub-group
 * per account and one row per `[[config.entries]]` row of its adapter.
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

  return (
    <Show when={view()}>
      {(v) => (
        <>
          <div class={styles.groupHead}>
            <span class={styles.groupTitle}>Files</span>
            <span class={styles.sectionRule} />
          </div>
          <Show
            when={v().declared}
            fallback={<div class={styles.cardMeta}>This adapter declares no files.</div>}
          >
            <div class={styles.accountsCard}>
              <For each={v().profiles}>
                {(profile) => (
                  <div class={styles.acctCard}>
                    <div class={styles.acctHead}>
                      <span class={styles.accountName}>{profile.label}</span>
                      <span class={styles.acctHome}>{profile.home}</span>
                    </div>
                    <ul class={styles.fileList}>
                      <For each={profile.entries}>
                        {(entry) => (
                          <FileRow
                            entry={entry}
                            profileId={profile.profileId}
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
              </For>
            </div>
          </Show>
        </>
      )}
    </Show>
  );
}

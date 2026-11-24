import { Errored, For, Show, createDeferred, createSignal, onCleanup, onSettled, refresh } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { File, FileCode, FileImage, FileSpreadsheet, FileText } from "../../components/Icon/icons";
import type { IconGlyph } from "../../components/Icon/icons";
import Icon from "../../components/Icon/Icon";
import Button from "../../components/Button/Button";
import { WorkingMark } from "../../components/Icon/statusMarks";
import { GroupHead } from "../LeftSidebar/SidebarRows";
import { bytes } from "../Chat/toolRenderers";
import { chatById } from "../../utils/chats";
import { isEditingNow } from "../../utils/editingNow";
import { isUnderPath } from "../../utils/pathScope";
import { emitWith, OPEN_IN_EDITOR, type FsChanged, type OpenInEditor } from "../../utils/events";
import styles from "./ArtifactsPanel.module.css";

export type Artifact = { path: string; name: string; size: number; modified: number };
type Artifacts = { made: Artifact[]; added: Artifact[] };

const KINDS: [RegExp, string, IconGlyph][] = [
  [/\.(md|markdown)$/i, "Markdown", FileText],
  [/\.(txt|log)$/i, "Text", FileText],
  [/\.csv$/i, "CSV", FileSpreadsheet],
  [/\.(tsv|xlsx?)$/i, "Spreadsheet", FileSpreadsheet],
  [/\.(png|jpe?g|gif|webp|svg|heic)$/i, "Image", FileImage],
  [/\.pdf$/i, "PDF", FileText],
  [/\.(json|ya?ml|toml|html?|css|[jt]sx?|py|rs|go|sh|sql)$/i, "Code", FileCode],
];

export function artifactKind(name: string): { label: string; icon: IconGlyph } {
  const hit = KINDS.find(([re]) => re.test(name));
  if (hit) return { label: hit[1], icon: hit[2] };
  const ext = name.includes(".") ? name.split(".").pop()!.toUpperCase() : "";
  return { label: ext || "File", icon: File };
}

export default function ArtifactsPanel(props: { chatId: string; root: string; activePath?: string | null }) {
  const [madeOpen, setMadeOpen] = createSignal(true);
  const [addedOpen, setAddedOpen] = createSignal(true);

  // Keyed on the transcripts and their stamps, which move at each turn end:
  // that is when an attachment can first appear.
  const list = createDeferred<Artifacts>(
    () => {
      const chat = chatById(props.chatId);
      const sessions = chat?.sessions ?? [];
      for (const s of sessions) void s.last_active;
      return invoke<Artifacts>("chat_artifacts", {
        folder: chat?.folder ?? props.root,
        transcripts: sessions.map((s) => s.path),
      });
    },
    { loadingValue: { made: [], added: [] } },
  );

  let unlisten: UnlistenFn | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  onSettled(() => {
    void (async () => {
      unlisten = await listen<FsChanged>("fs://changed", (e) => {
        const root = e.payload.root;
        if (root && !isUnderPath(root, props.root) && !isUnderPath(props.root, root)) return;
        clearTimeout(timer);
        timer = setTimeout(() => void refresh(list), 150);
      });
    })();
  });
  onCleanup(() => {
    unlisten?.();
    clearTimeout(timer);
  });

  const total = () => list().made.length + list().added.length;

  const row = (a: Artifact) => {
    const kind = artifactKind(a.name);
    const writing = () => isEditingNow(a.path);
    return (
      <li>
        <button
          type="button"
          class={[styles.row, { [styles.sel]: props.activePath === a.path }]}
          aria-current={props.activePath === a.path ? "true" : undefined}
          data-artifact={a.path}
          onClick={() => emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: a.path })}
        >
          <span class={styles.iconBox}>
            <Icon icon={kind.icon} />
          </span>
          <span class={styles.text}>
            <span class={styles.name}>{a.name}</span>
            <span class={styles.meta}>
              {kind.label} · {writing() ? "editing" : bytes(a.size)}
            </span>
          </span>
          <Show when={writing()}>
            <span class={styles.writing} role="img" aria-label="Being written">
              <WorkingMark animate />
            </span>
          </Show>
        </button>
      </li>
    );
  };

  const group = (label: string, items: () => Artifact[], open: () => boolean, toggle: () => void) => (
    <Show when={items().length > 0}>
      <GroupHead label={label} count={String(items().length)} open={open()} onToggle={toggle} />
      <Show when={open()}>
        <ul class={styles.list} aria-label={label}>
          <For each={items()}>{row}</For>
        </ul>
      </Show>
    </Show>
  );

  return (
    <div class={styles.panel} data-artifacts>
      <div class={styles.head}>
        <span class={styles.title}>Artifacts</span>
        <Errored fallback={null}>
          <span class={styles.count}>{total()}</span>
        </Errored>
      </div>
      <Errored
        fallback={(err, reset) => (
          <div class={styles.empty}>
            <p class={styles.emptyTitle}>The artifacts could not be listed</p>
            <p class={styles.emptyText}>{String(err())}</p>
            <Button size="xs" variant="ghost" onClick={() => reset()}>
              Try again
            </Button>
          </div>
        )}
      >
        <Show
          when={total() > 0}
          fallback={
            <div class={styles.empty}>
              <span class={styles.emptyIcon}>
                <Icon icon={File} />
              </span>
              <p class={styles.emptyTitle}>Nothing here yet</p>
              <p class={styles.emptyText}>Files this chat writes, and files you drop into it, show up here.</p>
            </div>
          }
        >
          <div class={styles.scroll}>
            {group(
              "Made in this chat",
              () => list().made,
              madeOpen,
              () => setMadeOpen((v) => !v),
            )}
            {group(
              "Added by you",
              () => list().added,
              addedOpen,
              () => setAddedOpen((v) => !v),
            )}
          </div>
        </Show>
      </Errored>
    </div>
  );
}

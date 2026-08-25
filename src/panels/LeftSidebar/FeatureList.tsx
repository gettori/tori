import { createSignal, For, Show, onMount, onCleanup, createMemo } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import FeatureItem, { type SpaceTint } from "./FeatureItem";
import Button from "../../components/Button/Button";
import NewFeatureDialog from "../../components/Dialogs/NewFeatureDialog";
import PromptModal from "../../components/Dialogs/PromptModal";
import ConfirmDialog from "../../components/Dialogs/ConfirmDialog";
import { pushToast } from "../../components/Toasts/Toasts";
import type { MenuItem } from "../../components/Menu/rows";
import type { RepoSpace } from "../../components/Dialogs/RepoChecklist";
import { memberState, type Feature, type Member, featureKey } from "../../utils/features";
import { purgeWorkspace } from "../../utils/purgeWorkspace";
import styles from "./FeatureList.module.css";

/** What the list needs from a Space: the tint for a chip and the projects for
 *  the creation checklist. The sidebar's own `Space` satisfies it as is. */
export type FeatureSpace = SpaceTint & RepoSpace;

/** The sidebar's Features mode: every Feature as a row, the dialogs that make
 *  or change one, and the toast for a creation that left a member failed.
 *  Mounted only in that mode, so it owns its own fetch and its own listeners;
 *  the sidebar hands it the Spaces and the shared filter string.
 *
 *  Two feeds keep it current. `features://changed` carries a whole Feature
 *  after every step of a creation, and is applied as is, no refetch, so chips
 *  flip one by one. `config://changed` fires once at the end (and whenever
 *  the tree changes for any other reason), and that one refetches. */
export default function FeatureList(props: {
  spaces: FeatureSpace[];
  query: string;
  class?: string;
  /** The selected Feature's id, so exactly one row reads as active. */
  activeId?: string | null;
  onSelect?: (feature: Feature) => void;
  /** The selected Feature was deleted; the shell drops the selection. */
  onDeleted?: (feature: Feature) => void;
}) {
  const [features, setFeatures] = createSignal<Feature[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [dialog, setDialog] = createSignal<{ feature?: Feature } | null>(null);
  const [renameReq, setRenameReq] = createSignal<Feature | null>(null);
  const [deleteReq, setDeleteReq] = createSignal<Feature | null>(null);

  // Latest request wins: a refetch started later must not be overwritten by
  // an earlier one that resolved later.
  let seq = 0;
  async function load() {
    const mine = ++seq;
    try {
      const list = (await invoke<Feature[] | null>("list_features")) ?? [];
      if (mine !== seq) return;
      setFeatures(list);
      setError(null);
    } catch (e) {
      if (mine !== seq) return;
      setError(String(e));
    }
  }

  function apply(feature: Feature) {
    setFeatures((prev) => {
      const i = prev.findIndex((f) => f.id === feature.id);
      if (i < 0) return [...prev, feature];
      const next = prev.slice();
      next[i] = feature;
      return next;
    });
  }

  let unlistenFeatures: UnlistenFn | undefined;
  let unlistenConfig: UnlistenFn | undefined;
  onMount(async () => {
    await load();
    unlistenFeatures = await listen<Feature>("features://changed", (e) => apply(e.payload));
    unlistenConfig = await listen("config://changed", () => load());
  });
  onCleanup(() => {
    unlistenFeatures?.();
    unlistenConfig?.();
  });

  async function retry(feature: Feature, member: Member) {
    try {
      const next = await invoke<Feature>("retry_member", {
        featureId: feature.id,
        repoPath: member.repoPath,
      });
      if (next) apply(next);
    } catch (e) {
      setError(String(e));
    }
  }

  // The dialog resolves with the settled record. A member the backend could
  // not build stays on the chip as a badge and gets one toast naming it, with
  // Retry running every failed member again.
  function settled(feature: Feature) {
    setDialog(null);
    apply(feature);
    const failed = feature.members.filter((m) => memberState(m.state).action === "retry");
    if (failed.length === 0) return;
    const names = failed.map((m) => m.displayName).join(", ");
    pushToast(`${feature.name}: no worktree for ${names}`, "error", {
      label: "Retry",
      run: () => failed.forEach((m) => void retry(feature, m)),
    });
  }

  async function rename(feature: Feature, name: string) {
    setRenameReq(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === feature.name) return;
    try {
      await invoke("rename_feature", { featureId: feature.id, name: trimmed });
      apply({ ...feature, name: trimmed });
    } catch (e) {
      setError(String(e));
    }
  }

  // The record is gone; so is every store keyed by it, before the selection
  // changes, so nothing persists the key back on the way out.
  async function remove(feature: Feature) {
    setDeleteReq(null);
    try {
      await invoke("delete_feature", { featureId: feature.id });
      setFeatures((prev) => prev.filter((f) => f.id !== feature.id));
      purgeWorkspace(featureKey(feature.id));
      props.onDeleted?.(feature);
    } catch (e) {
      setError(String(e));
    }
  }

  const menu = (feature: Feature): MenuItem[] => [
    { label: "Rename…", onClick: () => setRenameReq(feature) },
    { label: "Add repository…", onClick: () => setDialog({ feature }) },
    { separator: true },
    { label: "Delete…", danger: true, onClick: () => setDeleteReq(feature) },
  ];

  const deleteMessage = (feature: Feature) =>
    [
      `${feature.branch} stays checked out in every member; only the Feature record goes.`,
      "",
      ...[...feature.members]
        .sort((a, b) => a.order - b.order)
        .map((m) => `${m.displayName}: ${memberState(m.state).label}`),
    ].join("\n");

  const visible = createMemo(() => {
    const q = props.query.trim().toLowerCase();
    const all = [...features()].sort((a, b) => a.name.localeCompare(b.name));
    if (!q) return all;
    return all.filter(
      (f) => f.name.toLowerCase().includes(q) || f.members.some((m) => m.displayName.toLowerCase().includes(q)),
    );
  });

  return (
    <div class={styles.list} classList={{ [props.class ?? ""]: !!props.class }} data-feature-list>
      <div class={styles.header}>
        <Button size="sm" onClick={() => setDialog({})}>
          New Feature
        </Button>
      </div>
      <Show when={error()}>{(msg) => <p class={styles.error}>{msg()}</p>}</Show>
      <Show
        when={visible().length > 0}
        fallback={
          <div class="tree-empty">
            <Show when={features().length === 0} fallback={<p>No Feature matches the filter.</p>}>
              <p>No Features yet.</p>
              <Button size="sm" variant="ghost" onClick={() => setDialog({})}>
                Create a Feature
              </Button>
            </Show>
          </div>
        }
      >
        <ul class={styles.items}>
          <For each={visible()}>
            {(f) => (
              <FeatureItem
                feature={f}
                spaces={props.spaces}
                active={props.activeId === f.id}
                onSelect={props.onSelect}
                onRetry={(m) => retry(f, m)}
                menu={menu(f)}
              />
            )}
          </For>
        </ul>
      </Show>

      <Show when={dialog()}>
        {(req) => (
          <NewFeatureDialog
            spaces={props.spaces}
            features={features()}
            feature={req().feature}
            onDone={settled}
            onCancel={() => setDialog(null)}
          />
        )}
      </Show>

      <Show when={renameReq()}>
        {(f) => (
          <PromptModal
            title={`Rename ${f().name}`}
            initial={f().name}
            note={`${f().branch} stays as it is; only the name shown here changes.`}
            okLabel="Rename"
            onSubmit={(v) => void rename(f(), v)}
            onCancel={() => setRenameReq(null)}
          />
        )}
      </Show>

      <Show when={deleteReq()}>
        {(f) => (
          <ConfirmDialog
            title={`Delete ${f().name}?`}
            message={deleteMessage(f())}
            confirmLabel="Delete"
            danger
            onConfirm={() => void remove(f())}
            onCancel={() => setDeleteReq(null)}
          />
        )}
      </Show>
    </div>
  );
}

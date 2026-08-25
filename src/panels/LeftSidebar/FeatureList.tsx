import { createSignal, For, Show, onMount, onCleanup, createMemo } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import FeatureItem, { type SpaceTint } from "./FeatureItem";
import type { Feature, Member } from "../../utils/features";
import styles from "./FeatureList.module.css";

/** The sidebar's Features mode: every Feature as a row. Mounted only in that
 *  mode, so it owns its own fetch and its own listeners; the sidebar hands it
 *  the Spaces (for chip tints) and the shared filter string.
 *
 *  Two feeds keep it current. `features://changed` carries a whole Feature
 *  after every step of a creation, and is applied as is, no refetch, so chips
 *  flip one by one. `config://changed` fires once at the end (and whenever
 *  the tree changes for any other reason), and that one refetches. */
export default function FeatureList(props: { spaces: SpaceTint[]; query: string; class?: string }) {
  const [features, setFeatures] = createSignal<Feature[]>([]);
  const [error, setError] = createSignal<string | null>(null);

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
      <Show when={error()}>{(msg) => <p class={styles.error}>{msg()}</p>}</Show>
      <Show
        when={visible().length > 0}
        fallback={
          <div class="tree-empty">
            <p>{features().length === 0 ? "No Features yet." : "No Feature matches the filter."}</p>
          </div>
        }
      >
        <ul class={styles.items}>
          <For each={visible()}>
            {(f) => <FeatureItem feature={f} spaces={props.spaces} onRetry={(m) => retry(f, m)} />}
          </For>
        </ul>
      </Show>
    </div>
  );
}

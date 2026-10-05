// Every file of a pull request in one tab, stacked.
//
// The other half of the per-file tabs beside it. Those are for reading one file
// closely, with somewhere to go next; this is for reading the change in order,
// where reaching the bottom is what says the review is done. It shares the body,
// the threads and the composer with them, so it is a list container rather than
// a second review surface.
//
// ## A collapsed section renders nothing
//
// `PrFileBody` does word-level pairing for every hunk it is handed, so a mounted
// body is real work whether or not anybody scrolls to it. Three hundred of them
// is three hundred diffs laid out to show the first one. The store opens the
// first few on arrival (`fileExpanded`) and the rest mount when the reader opens
// them, which is also what keeps a section's state out of this view: the tab is
// unmounted while it is not the active one.
//
// It fetches nothing. `ensure` on mount and everything from `prReviewStore`, so
// this tab open beside the panel and four diff tabs is still one read of each.

import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { Check, ChevronDown, ChevronRight, ExternalLink, MessageSquare } from "lucide-solid";
import { parsePrArg } from "../../../utils/syntheticTabs";
import { sideBySideOn as sideBySide, SIDE_BY_SIDE_MIN_WIDTH } from "../../../utils/sideBySide";
import { bareKey, stepFocus } from "../../../utils/keyNav";
import { fileRowName } from "../../../utils/prFiles";
import { unitStatusForPr } from "../../../utils/forgeStatus";
import {
  ensure,
  fileExpanded,
  headDrift,
  isViewed,
  prEntry,
  refresh,
  setFileExpanded,
} from "../../../utils/prReviewStore";
import PrFileBody from "./PrFileBody";
import Button from "../../../components/Button/Button";
import IconButton from "../../../components/IconButton/IconButton";
import Icon from "../../../components/Icon/Icon";
import styles from "./PrAllFilesView.module.css";

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const fileDir = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

export default function PrAllFilesView(props: { workspace: string; arg: string }) {
  const number = createMemo(() => parsePrArg(props.arg));
  const [paneWidth, setPaneWidth] = createSignal(Infinity);

  const entry = createMemo(() => prEntry(props.workspace, number()));
  /// The poll first and the store second, the same order the diff and overview
  /// tabs read them in: the poll is fresher and already on screen, and the
  /// store's copy is what keeps a pull request on a branch this machine has no
  /// unit for from rendering as no pull request at all.
  const pr = createMemo(() => unitStatusForPr(props.workspace, number())?.pullRequest ?? entry().pr);
  const files = () => entry().files;
  const drifted = () => headDrift(props.workspace, number());
  /// The layout preference, shared with the per-file tabs. Read-only here: the
  /// toggle lives on a diff tab, where the header has room for it.
  const twoColumn = () => sideBySide() && paneWidth() >= SIDE_BY_SIDE_MIN_WIDTH;

  const unresolvedIn = (path: string) => entry().threads.filter((t) => t.path === path && !t.isResolved).length;
  /// This file's conversations that its rows cannot carry. Per section for the
  /// same reason the diff tab keeps them per file: a section is one file, so an
  /// outdated thread here either goes in its strip or disappears.
  const outdatedIn = (path: string) =>
    entry().threads.filter((t) => t.path === path && (t.line === null || t.isOutdated));

  /// The pull request's own totals, which only the detail read carries. Absent
  /// until it lands rather than summed from the files in hand, since those are
  /// capped and the sum would be quietly short.
  const totals = () => entry().summary?.counts ?? null;

  /// `300 of 412` where the API stopped describing the pull request, plain
  /// otherwise. A tab called "All files" whose count reads as the whole of a
  /// capped list is the one number here that must not be taken at face value.
  const filesCount = () => {
    const shown = files().length;
    const total = totals()?.changedFiles ?? null;
    return entry().filesTruncated && total !== null ? `${shown} of ${total}` : `${shown}`;
  };

  createEffect(on([() => props.workspace, number], ([root, n]) => ensure(root, n)));

  let paneRef: HTMLDivElement | undefined;
  onMount(() => {
    if (!paneRef) return;
    const ro = new ResizeObserver(([e]) => setPaneWidth(e.contentRect.width));
    ro.observe(paneRef);
    onCleanup(() => ro.disconnect());
  });

  /// The next file past the focused one that holds a conversation and is not
  /// open, or null once there is none in that direction.
  function nextFileWithThread(delta: 1 | -1): string | null {
    const held = new Set(entry().threads.map((t) => t.path));
    const order = files().map((f) => f.path);
    const inside = (document.activeElement as HTMLElement | null)
      ?.closest("[data-file-section]")
      ?.getAttribute("data-file-section");
    // Nothing focused yet means the walk starts outside the list, so the first
    // candidate in the direction of travel is the one wanted.
    const from = inside ? order.indexOf(inside) : delta === 1 ? -1 : order.length;
    for (let i = from + delta; i >= 0 && i < order.length; i += delta) {
      if (held.has(order[i])) return order[i];
    }
    return null;
  }

  /// `n` and `p` between this pull request's conversations.
  ///
  /// On the tab rather than on the cards, because the reader is usually in the
  /// rows and not in a conversation when they want the next one. `bareKey`
  /// holds the composer and every reply box harmless: a letter typed into text
  /// is text.
  ///
  /// **A collapsed section renders no cards**, which is why this cannot just
  /// step through what is on screen the way the per-file tab does: past the ten
  /// sections that open on arrival, a reader walking `n` would reach the end of
  /// a three-hundred-file pull request having passed most of its conversations
  /// without a word. So running out opens the next file that holds one.
  function onKeyDown(e: KeyboardEvent) {
    if (!paneRef) return;
    if (!bareKey(e, "n", "p")) return;
    const delta = e.key === "n" ? 1 : -1;
    if (stepFocus(paneRef, "[data-thread-id]", delta)) {
      e.preventDefault();
      return;
    }
    const next = nextFileWithThread(delta);
    if (!next) return;
    e.preventDefault();
    setFileExpanded(props.workspace, number(), next, true);
    // Found by walking rather than by an attribute selector: a path is not a
    // CSS string and quoting one is a rule with an escape in it.
    const section = [...paneRef.querySelectorAll<HTMLElement>("[data-file-section]")].find(
      (el) => el.dataset.fileSection === next,
    );
    if (section) stepFocus(section, "[data-thread-id]", delta);
  }

  return (
    <div class={styles.allFiles} ref={paneRef} onKeyDown={onKeyDown}>
      <div class={styles.topBar}>
        <Show when={pr()}>
          {(p) => (
            <>
              <span class={styles.number}>#{p().number}</span>
              <span class={styles.name}>{p().title}</span>
            </>
          )}
        </Show>
        <span class={styles.position}>
          {filesCount()} file{files().length === 1 ? "" : "s"}
        </span>
        <Show when={totals()}>
          {(n) => (
            <span class={styles.counts}>
              <span class={styles.added}>+{n().additions}</span>
              <span class={styles.removed}>-{n().deletions}</span>
            </span>
          )}
        </Show>
        <span class={styles.spacer} />
        <Show when={pr()}>
          {(p) => (
            <IconButton
              size="sm"
              icon={<Icon icon={ExternalLink} />}
              tooltip={`Open pull request ${p().number} on github.com`}
              onClick={() => window.open(`${p().url}/files`, "_blank", "noreferrer")}
            />
          )}
        </Show>
      </div>

      {/* The head has moved since these patches were read, so every anchor
          below describes a file the server no longer has. Offered a reload
          rather than re-fetching under the reader, the same way the diff tab
          does it. */}
      <Show when={drifted()}>
        <div class={styles.drift}>
          <span>This pull request has new commits since you read this.</span>
          <Button variant="ghost" onClick={() => void refresh(props.workspace, number(), "files")}>
            Reload the diff
          </Button>
        </div>
      </Show>

      <Show when={entry().filesError}>{(message) => <div class={styles.error}>{message()}</div>}</Show>
      <Show when={entry().threadsError}>{(message) => <div class={styles.error}>{message()}</div>}</Show>
      {/* This tab's name says "all files", so the one cap that contradicts it
          belongs at the top of it. Same for the conversations: a partial answer
          rendered as a complete one is the failure nobody reports. */}
      <Show when={entry().filesTruncated && pr()}>
        {(p) => (
          <div class={styles.notice}>
            This pull request changes more files than the API will describe.{" "}
            <a href={`${p().url}/files`} target="_blank" rel="noreferrer">
              See all of them on github.com
            </a>
          </div>
        )}
      </Show>
      <Show when={entry().threadsTruncated && pr()}>
        {(p) => (
          <div class={styles.notice}>
            This pull request has more conversations than one read can carry.{" "}
            <a href={p().url} target="_blank" rel="noreferrer">
              See them all on github.com
            </a>
          </div>
        )}
      </Show>

      <Show
        when={pr()}
        fallback={
          <div class="tree-empty">
            <Show when={!entry().filesLoading && !entry().filesError}>
              <p>No pull request here carries that number.</p>
            </Show>
          </div>
        }
      >
        {(p) => (
          <div class={styles.body}>
            <For each={files()}>
              {(f) => {
                const expanded = () => fileExpanded(props.workspace, number(), f.path);
                const viewed = () => isViewed(props.workspace, number(), f.path);
                return (
                  <section class={styles.file} data-file-section={f.path}>
                    {/* A heading per section, so three hundred files are three
                        hundred landmarks rather than one long page. */}
                    <h2 class={styles.fileHead}>
                      <button
                        type="button"
                        class={styles.fileToggle}
                        aria-expanded={expanded()}
                        aria-label={fileRowName(f, unresolvedIn(f.path), viewed())}
                        onClick={() => setFileExpanded(props.workspace, number(), f.path, !expanded())}
                      >
                        <Icon
                          icon={expanded() ? ChevronDown : ChevronRight}
                          size={14}
                          class={styles.chevron}
                          aria-hidden="true"
                        />
                        {/* Everything after the chevron is spelled out in the
                            button's own name, so none of it is read twice. */}
                        <span class={styles.status} data-file-status={f.status} aria-hidden="true">
                          {f.status.slice(0, 1).toUpperCase()}
                        </span>
                        <span class={styles.path} data-viewed={viewed() || undefined}>
                          {/* The directory truncates from its *start*, so the
                              filename is never what disappears. */}
                          <Show when={fileDir(f.path)}>
                            <span class={styles.dir}>{fileDir(f.path)}/</span>
                          </Show>
                          <span class={styles.fileName}>{fileName(f.path)}</span>
                        </span>
                        {/* Said on a collapsed section too, which is the point:
                            a file with a conversation in it must not read as a
                            file with nothing in it. */}
                        <Show when={unresolvedIn(f.path)}>
                          {(n) => (
                            <span class={styles.unresolved} aria-hidden="true">
                              <Icon icon={MessageSquare} size={12} />
                              {n()}
                            </span>
                          )}
                        </Show>
                        <Show when={viewed()}>
                          <Icon icon={Check} size={13} class={styles.viewedMark} aria-hidden="true" />
                        </Show>
                        <span class={styles.counts} aria-hidden="true">
                          <span class={styles.added}>+{f.additions}</span>
                          <span class={styles.removed}>-{f.deletions}</span>
                        </span>
                      </button>
                    </h2>
                    <Show when={expanded()}>
                      <div class={styles.fileBody} data-file-body={f.path}>
                        <PrFileBody
                          root={props.workspace}
                          pr={p()}
                          file={f}
                          twoColumn={twoColumn()}
                          outdated={outdatedIn(f.path)}
                        />
                      </div>
                    </Show>
                  </section>
                );
              }}
            </For>
          </div>
        )}
      </Show>
    </div>
  );
}

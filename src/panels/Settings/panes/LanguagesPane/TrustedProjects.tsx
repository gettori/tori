import { For, Show, createResource, createSignal, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import Button from "../../../../components/Button/Button";
import ConfirmDialog from "../../../../components/Dialogs/ConfirmDialog";
import OverlayScroll from "../../../../components/Scrollbar/OverlayScroll";
import { emitWith, TOAST, type ToastEvent } from "../../../../utils/events";
import { onTrustChange, refusedProjects, revokeProject, trustProject } from "../../../../utils/projectTrust";
import styles from "../../Settings.module.css";

type TrustTab = "trusted" | "untrusted";

const TRUST_TABS: { id: TrustTab; label: string }[] = [
  { id: "trusted", label: "Trusted" },
  { id: "untrusted", label: "Not trusted" },
];

export default function TrustedProjects() {
  const [trusted, { refetch: refetchTrusted }] = createResource(() => invoke<string[]>("trusted_projects"));
  const [discovered, { refetch: refetchDiscovered }] = createResource(() =>
    invoke<string[] | null>("untrusted_projects"),
  );
  onCleanup(
    onTrustChange(() => {
      void refetchTrusted();
      void refetchDiscovered();
    }),
  );
  const [picked, setPicked] = createSignal<TrustTab | null>(null);
  const [query, setQuery] = createSignal("");
  const [confirming, setConfirming] = createSignal(false);

  // Refused this session counts too: a project outside the discovery root is
  // never in the discovered list.
  const untrusted = () => [...new Set([...(discovered() ?? []), ...refusedProjects()])].sort();
  const rows = () => [
    ...[...(trusted() ?? [])].sort().map((path) => ({ path, trusted: true })),
    ...untrusted().map((path) => ({ path, trusted: false })),
  ];
  const count = (tab: TrustTab) => rows().filter((r) => r.trusted === (tab === "trusted")).length;
  const tab = () => picked() ?? TRUST_TABS.find((t) => count(t.id) > 0)?.id ?? "trusted";
  const q = () => query().trim().toLowerCase();
  const shown = () =>
    rows().filter((r) => (q() ? r.path.toLowerCase().includes(q()) : r.trusted === (tab() === "trusted")));

  const pick = (t: TrustTab) => {
    setPicked(t);
    setQuery("");
  };
  const run = (verb: string, change: Promise<unknown>) =>
    void change.catch((e) =>
      emitWith<ToastEvent>(TOAST, { message: `Could not ${verb} this project: ${String(e)}` }),
    );
  const revokeAll = () => {
    setConfirming(false);
    run("revoke", Promise.all((trusted() ?? []).map(revokeProject)));
  };

  return (
    <section class={styles.section}>
      <div class={styles.sectionTitle}>
        <span>Trusted projects</span>
        <span class={styles.sectionRule} />
        <div class={styles.groupTabs} role="group" aria-label="Show projects">
          <For each={TRUST_TABS}>
            {(t) => (
              <button
                type="button"
                class={styles.groupTab}
                aria-pressed={!q() && tab() === t.id}
                onClick={() => pick(t.id)}
              >
                {t.label}
                <span class={styles.groupTabCount}>{count(t.id)}</span>
              </button>
            )}
          </For>
        </div>
        <input
          type="text"
          class={styles.tableFilter}
          placeholder="Search"
          aria-label="Search projects"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <Show when={count("trusted") > 0}>
          <span class={styles.titleAction}>
            <Button size="xs" variant="ghost" onClick={() => setConfirming(true)}>
              Revoke all
            </Button>
          </span>
        </Show>
      </div>

      <Show
        when={shown().length > 0}
        fallback={
          <div class={styles.note}>
            {q()
              ? `No project matches "${query().trim()}".`
              : tab() === "trusted"
                ? "No trusted projects."
                : "Every project is trusted."}
          </div>
        }
      >
        <div class={styles.trustTable}>
          <div class={styles.trustHead}>
            <span />
            <span>Project</span>
            <span>Status</span>
            <span />
          </div>
          <OverlayScroll class={styles.trustScroll}>
            <For each={shown()}>
              {(r) => (
                <div class={styles.trustRow}>
                  <span class={`${styles.dot} ${r.trusted ? styles.dotOk : styles.dotOff}`} />
                  <code class={styles.trustPath} classList={{ [styles.trustPathOff]: !r.trusted }} title={r.path}>
                    {r.path}
                  </code>
                  <span class={styles.trustStatus}>{r.trusted ? "Trusted" : "Servers stay off"}</span>
                  <Show
                    when={r.trusted}
                    fallback={
                      <Button
                        variant="primary"
                        size="xs"
                        class={styles.trustAction}
                        aria-label={`Trust ${r.path}`}
                        onClick={() => run("trust", trustProject(r.path))}
                      >
                        Trust
                      </Button>
                    }
                  >
                    <Button
                      variant="ghost"
                      size="xs"
                      class={styles.trustAction}
                      aria-label={`Revoke ${r.path}`}
                      onClick={() => run("revoke", revokeProject(r.path))}
                    >
                      Revoke
                    </Button>
                  </Show>
                </div>
              )}
            </For>
          </OverlayScroll>
        </div>
      </Show>
      <div class={styles.note}>
        Servers that run a project's own code, like TypeScript and Rust, only start in trusted projects.
      </div>

      <Show when={confirming()}>
        <ConfirmDialog
          danger
          title="Revoke every trusted project?"
          message={`Servers that run a project's own code stop in all ${count("trusted")}, until you trust each one again here.`}
          confirmLabel="Revoke all"
          onConfirm={revokeAll}
          onCancel={() => setConfirming(false)}
        />
      </Show>
    </section>
  );
}

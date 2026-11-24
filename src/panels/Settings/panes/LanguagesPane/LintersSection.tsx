import { Errored, For, Loading, Show, createMemo, refresh, untrack } from "solid-js";
import Button from "../../../../components/Button/Button";
import { LspCard, probeLspHealth } from "./LspSection";
import { onPacksChanged } from "../../../../utils/packs";
import BrowsePacks from "../../components/BrowsePacks";
import styles from "../../Settings.module.css";

export default function LintersSection() {
  const health = createMemo(() => untrack(probeLspHealth));
  const recheck = () => refresh(health).catch(() => undefined);
  onPacksChanged("lsp", () => void recheck());
  const linters = () => health().filter((s) => s.role === "secondary");

  return (
    <section class={styles.section}>
      <div class={styles.sectionTitle}>
        <span>Linters</span>
        <span class={styles.sectionRule} />
        <BrowsePacks kind="lsp" role="secondary" class={styles.titleAction} />
      </div>
      <Errored
        fallback={(err, reset) => (
          <div class={styles.note}>
            Could not check linters: {String(err())}{" "}
            <Button size="xs" variant="ghost" onClick={() => reset()}>
              Try again
            </Button>
          </div>
        )}
      >
        <Loading fallback={<div class={styles.note}>Checking which linters are installed...</div>}>
          <Show when={linters().length > 0} fallback={<div class={styles.note}>No linter here.</div>}>
            <div class={styles.toolGrid}>
              <For each={linters()}>{(server) => <LspCard server={server} onChange={recheck} />}</For>
            </div>
          </Show>
          <div class={styles.note}>
            A linter runs beside the language's own server, in projects with its config. Add one with a TOML file in{" "}
            <code>~/.config/tori/packs/lsp/</code>; see LSP-SERVERS.md.
          </div>
        </Loading>
      </Errored>
    </section>
  );
}

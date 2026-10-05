import { For, Show, Switch, Match, createResource } from "solid-js";
import { LspCard, probeLspHealth } from "./LspSection";
import styles from "../../Settings.module.css";

export default function LintersSection() {
  const [health, { refetch }] = createResource(probeLspHealth);
  const linters = () => (health() ?? []).filter((s) => s.role === "secondary");

  return (
    <section class={styles.section}>
      <div class={styles.sectionTitle}>
        <span>Linters</span>
        <span class={styles.sectionRule} />
      </div>
      <Switch>
        <Match when={health.state === "pending"}>
          <div class={styles.note}>Checking which linters are installed...</div>
        </Match>
        <Match when={health.error}>
          <div class={styles.note}>Could not check linters: {String(health.error)}</div>
        </Match>
        <Match when={health()}>
          <Show when={linters().length > 0} fallback={<div class={styles.note}>No linter here.</div>}>
            <div class={styles.toolGrid}>
              <For each={linters()}>
                {(server) => <LspCard server={server} onChange={() => Promise.resolve(refetch())} />}
              </For>
            </div>
          </Show>
          <div class={styles.note}>
            A linter runs beside the language's own server, in projects with its config. Add one with a TOML file in{" "}
            <code>~/.config/tori/lsp/</code>; see LSP-SERVERS.md.
          </div>
        </Match>
      </Switch>
    </section>
  );
}

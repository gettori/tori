import { For, Show, Switch, Match, createResource, createSignal, type Resource } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { LspCard, TONE, type BinaryStatus, type LspHealth } from "./LspSection";
import styles from "../../Settings.module.css";

type FormatterHealth = {
  id: string;
  label: string;
  program: string;
  status: BinaryStatus;
  version: string | null;
  verifiedAgainst: string | null;
  // Null takes any file the formatter has a parser for.
  extensions: string[] | null;
  markers: string[];
  runsPerProject: boolean;
};

function FormatterCard(props: { formatter: FormatterHealth }) {
  const f = () => props.formatter;
  return (
    <div class={styles.toolCard}>
      <div class={styles.toolHead}>
        <span class={`${styles.dot} ${TONE[f().status]}`} />
        <span class={styles.toolName}>{f().label}</span>
        <span class={styles.kindTag}>Formatter</span>
      </div>
      <code class={styles.toolProgram}>{f().program}</code>

      <div class={styles.toolStatus}>
        <Show
          when={f().markers.length > 0}
          fallback={
            <>
              Runs where <code>format.byExtension</code> names it.
            </>
          }
        >
          Runs in projects with one of <code>{f().markers.join(", ")}</code>.
        </Show>{" "}
        <Switch>
          <Match when={f().runsPerProject}>
            From the project's own <code>node_modules</code> or <code>.venv</code>, else your PATH.
          </Match>
          <Match when={f().status === "notFound"}>
            Not installed. Install <code>{f().program}</code> and reopen Tori to pick it up.
          </Match>
          <Match when={f().status === "versionDrift"}>
            Installed, version {f().version}. Tori's config was built against {f().verifiedAgainst},
            so some behaviour may differ.
          </Match>
          <Match when={f().version}>Installed, version {f().version}.</Match>
          <Match when={true}>Installed. It does not report a version, so Tori cannot check it.</Match>
        </Switch>
      </div>

      <div class={styles.toolExts}>
        <For each={f().extensions ?? []}>{(ext) => <span>.{ext}</span>}</For>
      </div>
    </div>
  );
}

type Tab = "linters" | "formatters";

const TABS: { id: Tab; label: string }[] = [
  { id: "linters", label: "Linters" },
  { id: "formatters", label: "Formatters" },
];

export default function LintFormatSection(props: {
  health: Resource<LspHealth[]>;
  onChange: () => Promise<unknown>;
}) {
  const [formatters] = createResource(() => invoke<FormatterHealth[]>("formatter_health"));
  const linters = () => (props.health() ?? []).filter((s) => s.role === "secondary");
  const [tab, setTab] = createSignal<Tab>("linters");
  const count = (t: Tab) => (t === "linters" ? linters() : (formatters() ?? [])).length;
  const list = () => (tab() === "linters" ? props.health : formatters);

  return (
    <section class={styles.section}>
      <div class={styles.sectionTitle}>
        <span>Linters &amp; formatters</span>
        <span class={styles.sectionRule} />
        <div class={styles.groupTabs} role="group" aria-label="Show linters or formatters">
          <For each={TABS}>
            {(t) => (
              <button
                type="button"
                class={styles.groupTab}
                aria-pressed={tab() === t.id}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                <span class={styles.groupTabCount}>{count(t.id)}</span>
              </button>
            )}
          </For>
        </div>
      </div>
      <Switch>
        <Match when={list().state === "pending"}>
          <div class={styles.note}>Checking which {tab()} are installed...</div>
        </Match>
        <Match when={list().error}>
          <div class={styles.note}>
            Could not check {tab()}: {String(list().error)}
          </div>
        </Match>
        <Match when={tab() === "linters"}>
          <div class={styles.toolGrid}>
            <For each={linters()}>{(server) => <LspCard server={server} onChange={props.onChange} />}</For>
          </div>
          <div class={styles.note}>
            A linter runs beside the language's own server, in projects with its config. Add one
            with a TOML file in <code>~/.config/tori/lsp/</code>; see LSP-SERVERS.md.
          </div>
        </Match>
        <Match when={true}>
          <div class={styles.toolGrid}>
            <For each={formatters()}>{(formatter) => <FormatterCard formatter={formatter} />}</For>
          </div>
          <div class={styles.note}>
            Format Document, and format on save when it is on, use the formatter the project's config
            or <code>format.byExtension</code> names. With neither, the language server formats. Add
            one with a TOML file in <code>~/.config/tori/formatters/</code>; see FORMATTERS.md.
          </div>
        </Match>
      </Switch>
    </section>
  );
}

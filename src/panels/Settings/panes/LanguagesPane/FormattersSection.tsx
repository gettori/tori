import { For, Show, Switch, Match, createResource, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import Toggle from "../../../../components/Switch/Switch";
import { emitWith, TOAST, type ToastEvent } from "../../../../utils/events";
import { setFormatterDisabled } from "../../settingsStore";
import { TONE, type BinaryStatus } from "./LspSection";
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
  disabled: boolean;
};

function FormatterCard(props: { formatter: FormatterHealth }) {
  const f = () => props.formatter;
  // Kept here because `formatter_health` is not asked again after a save.
  const [turnedOff, setTurnedOff] = createSignal<boolean | null>(null);
  const off = () => turnedOff() ?? f().disabled;

  const use = (on: boolean) => {
    setTurnedOff(!on);
    setFormatterDisabled(f().id, !on).catch((e) => {
      setTurnedOff(null);
      emitWith<ToastEvent>(TOAST, { message: `Could not turn ${on ? "on" : "off"} ${f().label}: ${String(e)}` });
    });
  };

  return (
    <div class={styles.toolCard}>
      <div class={styles.toolHead}>
        <span class={`${styles.dot} ${off() ? styles.dotOff : TONE[f().status]}`} />
        <span class={styles.toolName} classList={{ [styles.toolNameOff]: off() }}>
          {f().label}
        </span>
        <span class={styles.kindTag}>Formatter</span>
        <Show when={off() || f().status !== "notFound" || f().runsPerProject}>
          <Toggle class={styles.toolSwitch} checked={!off()} aria-label={`Use ${f().label}`} onChange={use} />
        </Show>
      </div>
      <code class={styles.toolProgram}>{f().program}</code>

      <div class={styles.toolStatus}>
        <Show
          when={!off()}
          fallback={
            <>
              Disabled by <code>format.disabled</code> in settings.
            </>
          }
        >
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
        </Show>
      </div>

      <div class={styles.toolExts}>
        <For each={f().extensions ?? []}>{(ext) => <span>.{ext}</span>}</For>
      </div>
    </div>
  );
}

export default function FormattersSection() {
  const [formatters] = createResource(() => invoke<FormatterHealth[]>("formatter_health"));

  return (
    <section class={styles.section}>
      <div class={styles.sectionTitle}>
        <span>Formatters</span>
        <span class={styles.sectionRule} />
      </div>
      <Switch>
        <Match when={formatters.state === "pending"}>
          <div class={styles.note}>Checking which formatters are installed...</div>
        </Match>
        <Match when={formatters.error}>
          <div class={styles.note}>Could not check formatters: {String(formatters.error)}</div>
        </Match>
        <Match when={formatters()}>
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

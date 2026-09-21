import { For, Show, Switch, Match, createResource, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { CircleArrowUp, Download, Trash2 } from "lucide-solid";
import ConfirmDialog from "../../../../components/Dialogs/ConfirmDialog";
import Icon from "../../../../components/Icon/Icon";
import IconButton from "../../../../components/IconButton/IconButton";
import Toggle from "../../../../components/Switch/Switch";
import InlineJob from "../../../FirstRun/job/InlineJob";
import type { JobState } from "../../../FirstRun/job/InlineJobFrame";
import { emitWith, TOAST, type OpenJob, type ToastEvent } from "../../../../utils/events";
import { installServer, serverInstalled } from "../../../../utils/serverInstall";
import { overlayRoot, setServerDisabled } from "../../settingsStore";
import styles from "../../Settings.module.css";

// One card per registered language server, answering the same question the
// Agents cards answer for agent CLIs: "which languages does this thing
// actually have intelligence for on my machine?" The backend (`lsp_health`)
// resolves each binary against the login-shell PATH, so a server installed via
// rustup/mise shows as found rather than missing.
//
// Same tone rule as the agent cards: a missing server is not an error. Nobody
// has every language installed, so an uninstalled one gets an install hint and
// an unparseable version gets neutral text, never red.

export type BinaryStatus = "notFound" | "versionUnknown" | "versionMatch" | "versionDrift";

export type LspHealth = {
  id: string;
  label: string;
  role: "primary" | "secondary";
  program: string;
  status: BinaryStatus;
  path: string | null;
  version: string | null;
  verifiedAgainst: string | null;
  extensions: string[];
  // Set when something other than a missing `program` is wrong: today, a
  // bundled server whose entry script was never installed. `node` resolves
  // fine in that case, so without this the card would read healthy while every
  // start failed.
  detail: string | null;
  overridePath: string | null;
  disabled: boolean;
  // Only the workspace's list names it, and your settings cannot undo that.
  disabledByWorkspace: boolean;
  activationMarkers: string[];
  runsPerProject: boolean;
  hint: string | null;
  // The version Tori can install on this machine.
  availableVersion: string | null;
  // Tori's own copy, set only when that is the one that runs.
  installedVersion: string | null;
  // The toolchain's own commands, for a hint server that is found.
  update: string | null;
  uninstall: string | null;
};

// The Servers and Linters panes mount together with the panel, and this runs
// every server's binary, so the second one to ask shares the first's answer.
let probing: Promise<LspHealth[]> | null = null;
export function probeLspHealth(): Promise<LspHealth[]> {
  probing ??= invoke<LspHealth[]>("lsp_health", { root: overlayRoot() }).finally(() => {
    probing = null;
  });
  return probing;
}

// Identical mapping to the agent cards, and for the same reason: the dot
// answers "is this usable?" and nothing else, so `versionUnknown` is green.
// Neither bundled config declares a `verified_against`, so dimming them over
// Tori's own missing bookkeeping would mark two healthy servers as worse off.
export const TONE: Record<BinaryStatus, string> = {
  versionMatch: styles.dotOk,
  versionUnknown: styles.dotOk,
  versionDrift: styles.dotWarn,
  notFound: styles.dotOff,
};

// A hint names its command in backticks, the way the server TOMLs write it.
const commandIn = (hint: string | null) => hint?.match(/`([^`]+)`/)?.[1] ?? null;

type Tab = "ready" | "installable" | "manual";

const TABS: { id: Tab; label: string }[] = [
  { id: "ready", label: "Ready" },
  { id: "installable", label: "Installable" },
  { id: "manual", label: "Manual" },
];

// By what the user can do about it, not by whether it runs right now: a server
// turned off stays in its tab with its switch off.
function tabOf(s: LspHealth): Tab {
  if (s.installedVersion !== null || s.status !== "notFound") return "ready";
  return s.availableVersion !== null ? "installable" : "manual";
}

const kindOf = (s: LspHealth) => (s.role === "secondary" ? "Linter" : "LSP");

type Verb = "install" | "update" | "uninstall";
const VERB_LABEL: Record<Verb, string> = { install: "Install", update: "Update", uninstall: "Uninstall" };
const VERB_DONE: Record<Verb, string> = { install: "Installed", update: "Updated", uninstall: "Uninstalled" };

export function LspCard(props: { server: LspHealth; onChange: () => Promise<LspHealth[] | null | undefined> }) {
  const s = () => props.server;
  const [pending, setPending] = createSignal<"install" | "remove" | null>(null);
  // Flipped here as soon as it is saved, rather than after `lsp_health`
  // answers, which probes every binary again.
  const [turnedOff, setTurnedOff] = createSignal<boolean | null>(null);
  const off = () => turnedOff() ?? s().disabled;
  const outdated = () =>
    s().installedVersion !== null && s().availableVersion !== null && s().installedVersion !== s().availableVersion;
  const installable = () => s().installedVersion === null && s().status === "notFound" && s().availableVersion !== null;
  const command = () => (s().status === "notFound" ? commandIn(s().hint) : null);
  // Nothing to switch off. A per-project server can still be in the project,
  // and one already off keeps its switch so it can be turned back on.
  const switchable = () =>
    off() || s().status !== "notFound" || s().installedVersion !== null || s().runsPerProject;
  // Run here rather than as a dock tab, which would open behind this panel.
  const [job, setJob] = createSignal<{ verb: Verb; line: string; job: OpenJob } | null>(null);
  const [confirming, setConfirming] = createSignal(false);

  const runCommand = async (verb: Verb, line: string) => {
    setConfirming(false);
    const job: OpenJob = {
      id: `lsp-${verb}:${s().id}`,
      title: `${VERB_LABEL[verb]} ${s().label}`,
      cwd: await homeDir().catch(() => "/"),
      program: "/bin/sh",
      args: ["-c", line],
      interactive: true,
    };
    setJob({ verb, line, job });
  };

  // The card is rebuilt once health comes back, so what to say is decided
  // from the answer rather than from this card.
  const finished = async (verb: Verb, state: JobState) => {
    if (state !== "ok") return;
    const { id, label, program } = s();
    if (verb === "install") serverInstalled(id);
    const now = (await props.onChange())?.find((x) => x.id === id);
    const found = !!now && now.status !== "notFound";
    const toast = (message: string, ok: boolean) =>
      emitWith<ToastEvent>(TOAST, { message, kind: ok ? "info" : "error" });
    if (verb === "install") {
      const message = found
        ? `${label} is installed.`
        : `The ${label} install finished, but ${program} is still not on your PATH.`;
      toast(message, found);
    } else if (verb === "update") {
      toast(now?.version ? `${label} is on version ${now.version}.` : `The ${label} update finished.`, true);
    } else {
      const message = found
        ? `The ${label} uninstall finished, but ${program} is still on your PATH.`
        : `Uninstalled ${label}.`;
      toast(message, !found);
    }
  };

  // Install goes through `installServer` so files already open in the editor
  // pick the server up.
  const run = (verb: string, command: "lsp_install" | "lsp_uninstall") => {
    setPending(command === "lsp_install" ? "install" : "remove");
    const done = command === "lsp_install" ? installServer(s().id) : invoke(command, { serverId: s().id });
    done
      .then(() => props.onChange(), (e) =>
        emitWith<ToastEvent>(TOAST, { message: `Could not ${verb} ${s().label}: ${String(e)}` }),
      )
      .finally(() => setPending(null));
  };

  const use = (on: boolean) => {
    setTurnedOff(!on);
    setServerDisabled(s().id, !on).catch((e) => {
      setTurnedOff(null);
      emitWith<ToastEvent>(TOAST, { message: `Could not turn ${on ? "on" : "off"} ${s().label}: ${String(e)}` });
    });
  };

  return (
    <div class={styles.toolCard} classList={{ [styles.toolCardWide]: job() !== null }}>
      <div class={styles.toolHead}>
        <span class={`${styles.dot} ${off() ? styles.dotOff : TONE[s().status]}`} />
        <span class={styles.toolName} classList={{ [styles.toolNameOff]: off() }}>
          {s().label}
        </span>
        <span class={styles.kindTag}>{kindOf(s())}</span>
        <span class={styles.toolControls}>
          <Show when={switchable()}>
            <Toggle
              checked={!off()}
              disabled={s().disabledByWorkspace}
              aria-label={`Use ${s().label}`}
              onChange={use}
            />
          </Show>
          <Show when={!job()}>
            <Show when={command()}>
              {(cmd) => (
                <IconButton
                  size="sm"
                  icon={<Icon icon={Download} />}
                  tooltip="Install"
                  aria-label={`Install ${s().label}`}
                  onClick={() => void runCommand("install", cmd())}
                />
              )}
            </Show>
            <Show when={installable()}>
              <IconButton
                size="sm"
                icon={<Icon icon={Download} />}
                tooltip="Install"
                aria-label={`Install ${s().label}`}
                disabled={pending() !== null}
                onClick={() => run("install", "lsp_install")}
              />
            </Show>
            <Show when={s().update}>
              {(cmd) => (
                <IconButton
                  size="sm"
                  icon={<Icon icon={CircleArrowUp} />}
                  tooltip="Update"
                  aria-label={`Update ${s().label}`}
                  onClick={() => void runCommand("update", cmd())}
                />
              )}
            </Show>
            <Show when={outdated()}>
              <IconButton
                size="sm"
                icon={<Icon icon={CircleArrowUp} />}
                tooltip="Update"
                aria-label={`Update ${s().label}`}
                disabled={pending() !== null}
                onClick={() => run("update", "lsp_install")}
              />
            </Show>
            <Show when={s().uninstall}>
              <IconButton
                size="sm"
                icon={<Icon icon={Trash2} />}
                tooltip="Uninstall"
                aria-label={`Uninstall ${s().label}`}
                onClick={() => setConfirming(true)}
              />
            </Show>
            <Show when={s().installedVersion}>
              <IconButton
                size="sm"
                icon={<Icon icon={Trash2} />}
                tooltip="Remove"
                aria-label={`Remove ${s().label}`}
                disabled={pending() !== null}
                onClick={() => run("remove", "lsp_uninstall")}
              />
            </Show>
          </Show>
        </span>
      </div>
      <code class={styles.toolProgram}>{s().program}</code>

      <div class={styles.toolStatus}>
        <Switch>
          {/* Most specific first: a bundled server can be "not found" while its
              interpreter is present, and naming the interpreter there would
              send the user off installing something they already have. */}
          <Match when={s().disabledByWorkspace}>
            Disabled by <code>lsp.disabled</code> in this project's <code>.tori/settings.json</code>.
          </Match>
          <Match when={off()}>Disabled by <code>lsp.disabled</code> in settings.</Match>
          {/* Settings has no project to look in, so a probe here cannot say
              whether such a server would be found where it actually starts. */}
          <Match when={s().activationMarkers.length > 0}>
            Runs per project, in projects with one of <code>{s().activationMarkers.join(", ")}</code>.
          </Match>
          <Match when={s().runsPerProject}>
            Runs per project, from the project's own <code>node_modules</code> or <code>.venv</code>, or your PATH.
          </Match>
          <Match when={s().detail}>{(detail) => <>{detail()}</>}</Match>
          <Match when={pending() === "install"}>
            Installing {s().label}. A large server can take a minute to download.
          </Match>
          <Match when={s().installedVersion}>
            {(version) => (
              <>
                Installed by Tori, version {version()}.
                <Show when={outdated()}> Version {s().availableVersion} is available.</Show>
              </>
            )}
          </Match>
          <Match when={installable()}>
            Available, not installed. Tori can install version {s().availableVersion}.
          </Match>
          <Match when={command()}>Not installed. Install runs this in a terminal here.</Match>
          <Match when={s().status === "notFound" && s().hint}>{(hint) => <>Not installed. {hint()}</>}</Match>
          <Match when={s().status === "notFound"}>
            Not installed. Install <code>{s().program}</code> and reopen Tori to pick it up.
          </Match>
          <Match when={s().status === "versionMatch"}>Installed, version {s().version}.</Match>
          <Match when={s().status === "versionUnknown" && s().version}>
            Installed, version {s().version}.
          </Match>
          <Match when={s().status === "versionUnknown"}>
            Installed. It does not report a version, so Tori cannot check it.
          </Match>
          <Match when={s().status === "versionDrift"}>
            Installed, version {s().version}. Tori's config was built against {s().verifiedAgainst},
            so some behaviour may differ.
          </Match>
        </Switch>
      </div>

      <Show
        when={job()}
        fallback={
          <Show when={command()}>
            {(cmd) => (
              <div class={styles.cmd}>
                <span class={styles.cmdPrompt}>$</span>
                <code class={styles.cmdText}>{cmd()}</code>
              </div>
            )}
          </Show>
        }
      >
        {(j) => (
          <InlineJob
            job={j().job}
            command={j().line}
            okLine={`${VERB_DONE[j().verb]} ${s().label}.`}
            onCancel={() => setJob(null)}
            onState={(state) => void finished(j().verb, state)}
          />
        )}
      </Show>

      <div class={styles.toolExts}>
        <For each={s().extensions}>{(ext) => <span>.{ext}</span>}</For>
      </div>

      <Show when={s().overridePath}>
        {(path) => <div class={styles.toolMeta}>Overridden by {path()}</div>}
      </Show>

      <Show when={confirming() && s().uninstall}>
        {(cmd) => (
          <ConfirmDialog
            danger
            title={`Uninstall ${s().label}?`}
            message={`Runs ${cmd()} in a terminal here. Files that use ${s().label} lose it once Tori restarts.`}
            confirmLabel="Uninstall"
            onConfirm={() => void runCommand("uninstall", cmd())}
            onCancel={() => setConfirming(false)}
          />
        )}
      </Show>
    </div>
  );
}

export default function LspSection() {
  const [health, { refetch }] = createResource(probeLspHealth);
  const servers = () => (health() ?? []).filter((s) => s.role === "primary");
  const [picked, setPicked] = createSignal<Tab | null>(null);
  const [query, setQuery] = createSignal("");

  const q = () => query().trim().toLowerCase();
  const count = (tab: Tab) => servers().filter((s) => tabOf(s) === tab).length;
  // Until one is picked, the first tab with anything in it, so a machine with
  // nothing ready does not open on an empty list.
  const tab = () => picked() ?? TABS.find((t) => count(t.id) > 0)?.id ?? "ready";
  // A search looks in every tab, the way the settings search looks in every
  // pane, so a server is never hidden behind the tab it is not in.
  const matches = (s: LspHealth) =>
    [s.label, s.program, kindOf(s), ...s.extensions.map((e) => `.${e}`)].some((f) => f.toLowerCase().includes(q()));
  const shown = () => servers().filter((s) => (q() ? matches(s) : tabOf(s) === tab()));

  const pick = (t: Tab) => {
    setPicked(t);
    setQuery("");
  };

  return (
    <section class={styles.section}>
      <div class={styles.sectionTitle}>
        <span>Language servers</span>
        <span class={styles.sectionRule} />
        <div class={styles.groupTabs} role="group" aria-label="Show language servers">
          <For each={TABS}>
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
          aria-label="Search language servers"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
      </div>
      <Switch>
        <Match when={health.state === "pending"}>
          <div class={styles.note}>Checking which language servers are installed…</div>
        </Match>
        <Match when={health.error}>
          <div class={styles.note}>Could not check language servers: {String(health.error)}</div>
        </Match>
        <Match when={health()}>
          <Show
            when={shown().length > 0}
            fallback={
              <div class={styles.note}>
                {q() ? `No language server matches "${query().trim()}".` : "No language server here."}
              </div>
            }
          >
            <div class={styles.toolGrid}>
              <For each={shown()}>
                {(server) => <LspCard server={server} onChange={() => Promise.resolve(refetch())} />}
              </For>
            </div>
          </Show>
          <div class={styles.note}>
            A language with no server still opens and edits normally, it just has no completion or
            diagnostics. Add one with a TOML file in <code>~/.config/tori/lsp/</code>; see
            LSP-SERVERS.md.
          </div>
        </Match>
      </Switch>
    </section>
  );
}

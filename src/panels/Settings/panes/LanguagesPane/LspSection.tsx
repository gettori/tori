import { For, Show, Switch, Match, createResource, createSignal, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import Button from "../../../../components/Button/Button";
import { emitWith, TOAST, type ToastEvent } from "../../../../utils/events";
import { onTrustChange, refusedProjects, revokeProject, trustProject } from "../../../../utils/projectTrust";
import { installServer } from "../../../../utils/serverInstall";
import { overlayRoot } from "../../settingsStore";
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

type BinaryStatus = "notFound" | "versionUnknown" | "versionMatch" | "versionDrift";

export type LspHealth = {
  id: string;
  label: string;
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
  activationMarkers: string[];
  runsPerProject: boolean;
  hint: string | null;
  // The version Tori can install on this machine.
  availableVersion: string | null;
  // Tori's own copy, set only when that is the one that runs.
  installedVersion: string | null;
};

// Identical mapping to the agent cards, and for the same reason: the dot
// answers "is this usable?" and nothing else, so `versionUnknown` is green.
// Neither bundled config declares a `verified_against`, so dimming them over
// Tori's own missing bookkeeping would mark two healthy servers as worse off.
const TONE: Record<BinaryStatus, string> = {
  versionMatch: styles.dotOk,
  versionUnknown: styles.dotOk,
  versionDrift: styles.dotWarn,
  notFound: styles.dotOff,
};

// Hints mark commands with backticks, the way the server TOMLs write them.
const withCode = (text: string) => text.split("`").map((part, i) => (i % 2 ? <code>{part}</code> : part));

function LspCard(props: { server: LspHealth; onChange: () => Promise<unknown> }) {
  const s = () => props.server;
  const [pending, setPending] = createSignal<"install" | "remove" | null>(null);
  const outdated = () =>
    s().installedVersion !== null && s().availableVersion !== null && s().installedVersion !== s().availableVersion;
  const installable = () => s().installedVersion === null && s().status === "notFound" && s().availableVersion !== null;

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

  return (
    <div class={styles.card}>
      <div class={styles.cardHead}>
        <span class={`${styles.dot} ${s().disabled ? styles.dotOff : TONE[s().status]}`} />
        <span class={styles.cardTitle}>{s().label}</span>
        <code class={styles.cardProgram}>{s().program}</code>
      </div>

      <div class={styles.cardStatus}>
        <Switch>
          {/* Most specific first: a bundled server can be "not found" while its
              interpreter is present, and naming the interpreter there would
              send the user off installing something they already have. */}
          <Match when={s().disabled}>Disabled by <code>lsp.disabled</code> in settings.</Match>
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
          <Match when={s().status === "notFound" && s().hint}>
            {(hint) => <>Not installed. {withCode(hint())}</>}
          </Match>
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

      <div class={styles.chips}>
        <For each={s().extensions}>
          {(ext) => <span class={styles.chip}>.{ext}</span>}
        </For>
      </div>

      <Show when={!s().disabled && (installable() || s().installedVersion)}>
        <div class={styles.cardActions}>
          <Show when={installable()}>
            <Button
              variant="primary"
              size="xs"
              aria-label={`Install ${s().label}`}
              disabled={pending() !== null}
              onClick={() => run("install", "lsp_install")}
            >
              Install
            </Button>
          </Show>
          <Show when={outdated()}>
            <Button
              variant="primary"
              size="xs"
              aria-label={`Update ${s().label}`}
              disabled={pending() !== null}
              onClick={() => run("update", "lsp_install")}
            >
              Update
            </Button>
          </Show>
          <Show when={s().installedVersion}>
            <Button
              variant="ghost"
              size="xs"
              aria-label={`Remove ${s().label}`}
              disabled={pending() !== null}
              onClick={() => run("remove", "lsp_uninstall")}
            >
              Remove
            </Button>
          </Show>
        </div>
      </Show>

      <Show when={s().overridePath}>
        {(path) => <div class={styles.hint}>Overridden by {path()}</div>}
      </Show>
    </div>
  );
}

function TrustedProjects() {
  const [trusted, { refetch }] = createResource(() => invoke<string[]>("trusted_projects"));
  onCleanup(onTrustChange(() => void refetch()));

  const run = (verb: string, change: Promise<void>) =>
    void change.catch((e) =>
      emitWith<ToastEvent>(TOAST, { message: `Could not ${verb} this project: ${String(e)}` }),
    );

  return (
    <div class={styles.card}>
      <div class={styles.cardHead}>
        <span class={styles.cardTitle}>Trusted projects</span>
      </div>
      <div class={styles.cardStatus}>
        Servers that run a project's own code, like TypeScript and Rust, only start in these.
      </div>
      <For each={refusedProjects()}>
        {(path) => (
          <div class={styles.cardActions}>
            <code class={styles.cardProgram}>{path}</code>
            <Button
              variant="primary"
              size="xs"
              aria-label={`Trust ${path}`}
              onClick={() => run("trust", trustProject(path))}
            >
              Trust
            </Button>
          </div>
        )}
      </For>
      <For each={trusted() ?? []}>
        {(path) => (
          <div class={styles.cardActions}>
            <code class={styles.cardProgram}>{path}</code>
            <Button
              variant="ghost"
              size="xs"
              aria-label={`Revoke ${path}`}
              onClick={() => run("revoke", revokeProject(path))}
            >
              Revoke
            </Button>
          </div>
        )}
      </For>
    </div>
  );
}

export default function LspSection() {
  const [health, { refetch }] = createResource(() => invoke<LspHealth[]>("lsp_health", { root: overlayRoot() }));

  return (
    <section class={styles.section}>
      <div class={styles.sectionTitle}>
        <span>Language servers</span>
        <span class={styles.sectionRule} />
      </div>
      <Switch>
        <Match when={health.state === "pending"}>
          <div class={styles.note}>Checking which language servers are installed…</div>
        </Match>
        <Match when={health.error}>
          <div class={styles.note}>Could not check language servers: {String(health.error)}</div>
        </Match>
        <Match when={health()}>
          <div class={styles.cardStack}>
            <For each={health()}>{(server) => <LspCard server={server} onChange={() => Promise.resolve(refetch())} />}</For>
          </div>
          <div class={styles.note}>
            A language with no server still opens and edits normally, it just has no completion or
            diagnostics. Add one with a TOML file in <code>~/.config/tori/lsp/</code>; see
            LSP-SERVERS.md.
          </div>
        </Match>
      </Switch>
      <TrustedProjects />
    </section>
  );
}

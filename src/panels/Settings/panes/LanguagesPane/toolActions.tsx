import { Show, createSignal } from "solid-js";
import { homeDir } from "@tauri-apps/api/path";
import { CircleArrowUp, Download, Trash2 } from "lucide-solid";
import ConfirmDialog from "../../../../components/Dialogs/ConfirmDialog";
import Icon from "../../../../components/Icon/Icon";
import IconButton from "../../../../components/IconButton/IconButton";
import InlineJob from "../../../FirstRun/job/InlineJob";
import type { JobState } from "../../../FirstRun/job/InlineJobFrame";
import { emitWith, TOAST, type OpenJob, type ToastEvent } from "../../../../utils/events";
import { commandIn } from "../../../../utils/serverInstall";
import { CmdField } from "../../components/paneKit";
import type { BinaryStatus } from "./LspSection";

// Install, Update and Uninstall for a language server or debugger card: the
// hint's commands run in a terminal inside the card, Tori's own install through
// `install` and `remove`.

export type ToolHealth = {
  id: string;
  label: string;
  program: string;
  status: BinaryStatus;
  version: string | null;
  hint: string | null;
  update: string | null;
  uninstall: string | null;
  availableVersion: string | null;
  installedVersion: string | null;
};

type Verb = "install" | "update" | "uninstall";
const VERB_LABEL: Record<Verb, string> = { install: "Install", update: "Update", uninstall: "Uninstall" };
const VERB_DONE: Record<Verb, string> = { install: "Installed", update: "Updated", uninstall: "Uninstalled" };

export function createToolActions(opts: {
  tool: () => ToolHealth;
  /** Keeps the job ids of the two sections apart. */
  scope: "lsp" | "dap";
  onChange: () => Promise<readonly ToolHealth[] | null | undefined>;
  install: (id: string) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
  onHintInstalled?: (id: string) => void;
  uninstallNote?: () => string;
}) {
  const t = opts.tool;
  const [pending, setPending] = createSignal<"install" | "remove" | null>(null);
  // Run here rather than as a dock tab, which would open behind this panel.
  const [job, setJob] = createSignal<{ verb: Verb; line: string; job: OpenJob } | null>(null);
  const [confirming, setConfirming] = createSignal(false);
  const outdated = () =>
    t().installedVersion !== null && t().availableVersion !== null && t().installedVersion !== t().availableVersion;
  const installable = () => t().installedVersion === null && t().status === "notFound" && t().availableVersion !== null;
  const command = () => (t().status === "notFound" ? commandIn(t().hint) : null);

  const runCommand = async (verb: Verb, line: string) => {
    setConfirming(false);
    const job: OpenJob = {
      id: `${opts.scope}-${verb}:${t().id}`,
      title: `${VERB_LABEL[verb]} ${t().label}`,
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
    const { id, label, program } = t();
    if (verb === "install") opts.onHintInstalled?.(id);
    const now = (await opts.onChange())?.find((x) => x.id === id);
    const found = !!now && now.status !== "notFound";
    const toast = (message: string, ok: boolean) =>
      emitWith<ToastEvent>(TOAST, { message, kind: ok ? "info" : "error" });
    if (verb === "install") {
      // Not "not on your PATH": `xcode-select --install` exits as soon as
      // Apple's installer opens, long before lldb-dap lands.
      const message = found
        ? `${label} is installed.`
        : `The ${label} install finished, but Tori does not find ${program} yet.`;
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

  const run = (verb: "install" | "update" | "remove") => {
    setPending(verb === "remove" ? "remove" : "install");
    (verb === "remove" ? opts.remove : opts.install)(t().id)
      .then(() => opts.onChange(), (e) =>
        emitWith<ToastEvent>(TOAST, { message: `Could not ${verb} ${t().label}: ${String(e)}` }),
      )
      .finally(() => setPending(null));
  };

  const Controls = () => (
    <Show when={!job()}>
      <Show when={command()}>
        {(cmd) => (
          <IconButton
            size="sm"
            icon={<Icon icon={Download} />}
            tooltip="Install"
            aria-label={`Install ${t().label}`}
            onClick={() => void runCommand("install", cmd())}
          />
        )}
      </Show>
      <Show when={installable()}>
        <IconButton
          size="sm"
          icon={<Icon icon={Download} />}
          tooltip="Install"
          aria-label={`Install ${t().label}`}
          disabled={pending() !== null}
          onClick={() => run("install")}
        />
      </Show>
      <Show when={t().update}>
        {(cmd) => (
          <IconButton
            size="sm"
            icon={<Icon icon={CircleArrowUp} />}
            tooltip="Update"
            aria-label={`Update ${t().label}`}
            onClick={() => void runCommand("update", cmd())}
          />
        )}
      </Show>
      <Show when={outdated()}>
        <IconButton
          size="sm"
          icon={<Icon icon={CircleArrowUp} />}
          tooltip="Update"
          aria-label={`Update ${t().label}`}
          disabled={pending() !== null}
          onClick={() => run("update")}
        />
      </Show>
      <Show when={t().uninstall}>
        <IconButton
          size="sm"
          icon={<Icon icon={Trash2} />}
          tooltip="Uninstall"
          aria-label={`Uninstall ${t().label}`}
          onClick={() => setConfirming(true)}
        />
      </Show>
      <Show when={t().installedVersion}>
        <IconButton
          size="sm"
          icon={<Icon icon={Trash2} />}
          tooltip="Remove"
          aria-label={`Remove ${t().label}`}
          disabled={pending() !== null}
          onClick={() => run("remove")}
        />
      </Show>
    </Show>
  );

  const Job = () => (
    <Show when={job()} fallback={<Show when={command()}>{(cmd) => <CmdField text={cmd()} />}</Show>}>
      {(j) => (
        <InlineJob
          job={j().job}
          command={j().line}
          okLine={`${VERB_DONE[j().verb]} ${t().label}.`}
          onCancel={() => setJob(null)}
          onState={(state) => void finished(j().verb, state)}
        />
      )}
    </Show>
  );

  const Confirm = () => (
    <Show when={confirming() && t().uninstall}>
      {(cmd) => (
        <ConfirmDialog
          danger
          title={`Uninstall ${t().label}?`}
          message={[`Runs ${cmd()} in a terminal here.`, opts.uninstallNote?.()].filter(Boolean).join(" ")}
          confirmLabel="Uninstall"
          onConfirm={() => void runCommand("uninstall", cmd())}
          onCancel={() => setConfirming(false)}
        />
      )}
    </Show>
  );

  return { pending, job, outdated, installable, command, Controls, Job, Confirm };
}

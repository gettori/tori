import { createResource, createSignal, For, Match, Show, Switch } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import { dismissPackInstall, pendingPackInstall, type PackInstallOrigin } from "../../utils/packInstall";
import { KIND_NOUN, type CatalogRow, type InstallNext, type PackKind } from "../../utils/packs";

const ORIGIN: Record<PackInstallOrigin, string> = {
  link: "A link asked Tori to install this pack.",
  editor: "Offered for the file you opened.",
  upgrade: "Your settings name this pack, and Tori no longer ships it.",
};

function blocker(r: CatalogRow): string | null {
  if (r.customFile) return "Your own file uses this id. Rename yours to install this one.";
  if (r.installed) return "Already installed.";
  if (r.bundled) return "Tori ships this pack already.";
  return null;
}

const hintLine = (next: InstallNext) => (next.step === "hint" ? (next.command ?? next.text) : null);

function doneCopy(kind: PackKind, next: InstallNext): string {
  switch (next.step) {
    case "hint":
      return "Installed. The server comes from its own toolchain:";
    case "managed":
      return kind === "dap"
        ? "Installed. Tori installs the debugger from its card in Settings."
        : "Installed. Tori offers to install the server the next time a file it handles is open.";
    case "nothing":
      switch (kind) {
        case "themes":
          return "Installed. Pick it under Settings, Appearance.";
        case "agents":
          return "Installed. Tori lists it under Settings, Agents.";
        case "formatters":
          return "Installed. Tori uses it when it formats a file it handles.";
        default:
          return "Installed.";
      }
  }
}

// Enter is caught for the whole panel: a link can open this while the user is
// typing, and a key meant for a terminal must not land on Install.
export default function PackInstallDialog() {
  return (
    <Show when={pendingPackInstall()} keyed>
      {(request) => {
        let cancel: HTMLButtonElement | undefined;
        const [row] = createResource(() =>
          invoke<CatalogRow>("packs_resolve", {
            kind: request.kind,
            id: request.id,
          }),
        );
        const [busy, setBusy] = createSignal(false);
        const [failed, setFailed] = createSignal<string | null>(null);
        const [done, setDone] = createSignal<InstallNext | null>(null);
        const noun = KIND_NOUN[request.kind];
        // Reading an errored resource throws, so the row is only read once it is ready.
        const ready = () => (row.state === "ready" ? row() : undefined);
        const label = () => ready()?.pack.label ?? request.id;
        const canInstall = () => {
          const r = ready();
          return !!r && !blocker(r) && !busy() && !done();
        };

        const install = () => {
          if (!canInstall()) return;
          setBusy(true);
          setFailed(null);
          invoke<InstallNext>("packs_install", {
            kind: request.kind,
            id: request.id,
          })
            .then((next) => setDone(next))
            .catch((err) => setFailed(String(err)))
            .finally(() => setBusy(false));
        };

        return (
          <Dialog
            open
            title={`Install ${label()}`}
            onClose={() => dismissPackInstall()}
            initialFocus={() => cancel}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.preventDefault();
            }}
            actions={
              <Show
                when={!done()}
                fallback={
                  <Button variant="primary" onClick={() => dismissPackInstall()}>
                    Close
                  </Button>
                }
              >
                <Button ref={cancel} onClick={() => dismissPackInstall()}>
                  Cancel
                </Button>
                <Button variant="primary" disabled={!canInstall()} onClick={install}>
                  {busy() ? "Installing..." : "Install"}
                </Button>
              </Show>
            }
          >
            <div class={styles.msg}>{ORIGIN[request.origin]}</div>
            <Switch>
              <Match when={row.state === "pending"}>
                <div class={styles.note}>Asking the catalog...</div>
              </Match>
              <Match when={row.error}>
                <div class={styles.warning}>Tori will not install this pack: {String(row.error)}</div>
              </Match>
              <Match when={done()}>
                {(next) => (
                  <>
                    <div class={styles.note}>{doneCopy(request.kind, next())}</div>
                    <Show when={hintLine(next())}>{(line) => <div class={styles.path}>{line()}</div>}</Show>
                  </>
                )}
              </Match>
              <Match when={ready()}>
                {(r) => (
                  <>
                    <div class={styles.note}>
                      <strong>{label()}</strong>, a {noun}
                      <Show when={r().pack.description}>{(text) => <>. {text()}</>}</Show>
                    </div>
                    <Show when={r().pack.contributor}>
                      {(who) => (
                        <div class={styles.note}>
                          By {who().name} (@{who().github})
                          <Show when={r().pack.license}>{(license) => <>, {license()}</>}</Show>
                        </div>
                      )}
                    </Show>
                    <div class={styles.note}>
                      Runs on{" "}
                      <For each={r().pack.platforms}>
                        {(p, i) => (
                          <>
                            {i() > 0 ? ", " : ""}
                            {p}
                          </>
                        )}
                      </For>
                    </div>
                    <Show when={r().pack.runs_project_code}>
                      <div class={styles.warning}>
                        This server runs code from the projects it opens, the way a build does.
                      </div>
                    </Show>
                    <Show when={blocker(r())}>{(why) => <div class={styles.note}>{why()}</div>}</Show>
                    <Show when={failed()}>{(err) => <div class={styles.warning}>Could not install: {err()}</div>}</Show>
                  </>
                )}
              </Match>
            </Switch>
          </Dialog>
        );
      }}
    </Show>
  );
}

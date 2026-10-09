import { For, Match, Show, Switch, createResource, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import Button from "../../../components/Button/Button";
import { agentIdForProgram } from "../../../utils/agents";
import { emitWith, TOAST, type ToastEvent } from "../../../utils/events";
import { loadCatalog, type CatalogPack, type CatalogRow, type PackKind } from "../../../utils/packs";
import { open as openTabs, tabState } from "../../Terminal/terminalTabStore";
import styles from "../Settings.module.css";

const agentInUse = (id: string) =>
  openTabs().some(
    (t) => (t.kind === "agent" || t.kind === "chat") && tabState(t) !== "inert" && agentIdForProgram(t.program) === id,
  );

function stateOf(r: CatalogRow): string | null {
  if (r.customFile) return "Your custom file uses this id";
  if (r.updateAvailable) return "Update available";
  if (r.installed) return "Installed";
  if (r.bundled) return "Bundled";
  return null;
}

const PROBLEM = {
  offline: "The catalog could not be reached",
  unverified: "The catalog did not verify",
  record: "Tori could not read installed.json",
};

/** An "Add a ..." button and, once pressed, the catalog's packs of one kind. */
export default function AddPack(props: { kind: PackKind; label: string; filter?: (p: CatalogPack) => boolean }) {
  const [shown, setShown] = createSignal(false);
  const [catalog, { refetch }] = createResource(shown, () => loadCatalog());
  const [busy, setBusy] = createSignal<string | null>(null);
  const rows = () =>
    (catalog()?.rows ?? []).filter((r) => r.pack.kind === props.kind && (props.filter?.(r.pack) ?? true));

  const run = (command: "packs_install" | "packs_update" | "packs_remove", r: CatalogRow) => {
    const id = r.pack.id;
    if (props.kind === "agents" && (r.installed || r.bundled) && agentInUse(id)) {
      emitWith<ToastEvent>(TOAST, { message: `Close the tabs using ${id} first.` });
      return;
    }
    setBusy(id);
    invoke(command, { kind: props.kind, id })
      .then(() => refetch())
      .catch((err) => emitWith<ToastEvent>(TOAST, { message: `Could not change ${id}: ${String(err)}` }))
      .finally(() => setBusy(null));
  };

  return (
    <>
      <div>
        <Button size="xs" aria-expanded={shown()} onClick={() => setShown(!shown())}>
          {props.label}
        </Button>
      </div>
      <Show when={shown()}>
        <Switch>
          <Match when={catalog.state === "pending"}>
            <div class={styles.note}>Asking the catalog...</div>
          </Match>
          <Match when={catalog.error}>
            <div class={styles.note}>The catalog could not be read: {String(catalog.error)}</div>
          </Match>
          <Match when={catalog()}>
            {(c) => (
              <>
                <Show when={c().problem}>
                  {(p) => (
                    <div class={styles.note}>
                      {PROBLEM[p().kind]}: {p().message}
                    </div>
                  )}
                </Show>
                <Show when={c().stale && c().generatedAt}>
                  {(at) => <div class={styles.note}>Catalog last refreshed on {at().slice(0, 10)}.</div>}
                </Show>
                <div class={styles.toolGrid}>
                  <For each={rows()}>
                    {(r) => (
                      <div class={styles.toolCard} data-pack={r.pack.id}>
                        <div class={styles.toolHead}>
                          <span class={styles.toolName}>{r.pack.label ?? r.pack.id}</span>
                          <Show when={stateOf(r)}>{(state) => <span class={styles.kindTag}>{state()}</span>}</Show>
                          <span class={styles.toolControls}>
                            <Switch>
                              <Match when={r.customFile}>
                                <Button size="xs" disabled>
                                  Install
                                </Button>
                              </Match>
                              <Match when={r.installed}>
                                <Show when={r.updateAvailable}>
                                  <Button size="xs" disabled={busy() !== null} onClick={() => run("packs_update", r)}>
                                    Update
                                  </Button>
                                </Show>
                                <Button size="xs" disabled={busy() !== null} onClick={() => run("packs_remove", r)}>
                                  Remove
                                </Button>
                              </Match>
                              <Match when={r.bundled && r.updateAvailable}>
                                <Button size="xs" disabled={busy() !== null} onClick={() => run("packs_install", r)}>
                                  Update
                                </Button>
                              </Match>
                              <Match when={!r.bundled}>
                                <Button
                                  size="xs"
                                  variant="primary"
                                  disabled={busy() !== null}
                                  onClick={() => run("packs_install", r)}
                                >
                                  Install
                                </Button>
                              </Match>
                            </Switch>
                          </span>
                        </div>
                        <Show when={r.pack.description}>{(text) => <div class={styles.toolStatus}>{text()}</div>}</Show>
                        <Show when={r.pack.contributor}>
                          {(who) => (
                            <div class={styles.toolMeta}>
                              By {who().name} (@{who().github})
                              <Show when={r.pack.license}>{(license) => <>, {license()}</>}</Show>
                            </div>
                          )}
                        </Show>
                        <Show when={r.pack.verified_against}>
                          {(version) => (
                            <div class={styles.toolMeta}>
                              Verified against {version()}
                              <Show when={r.pack.verified_on}>{(on) => <> on {on()}</>}</Show>
                            </div>
                          )}
                        </Show>
                        <div class={styles.toolExts}>
                          <For each={r.pack.platforms}>{(p) => <span>{p}</span>}</For>
                        </div>
                        <Show when={r.customFile}>
                          <div class={styles.toolMeta}>Rename yours to install this one.</div>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </>
            )}
          </Match>
        </Switch>
      </Show>
    </>
  );
}

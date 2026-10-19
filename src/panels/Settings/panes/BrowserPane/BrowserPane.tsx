import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Group, Row, idsIn, type PaneProps } from "../../components/paneKit";
import styles from "../../Settings.module.css";
import Button from "../../../../components/Button/Button";
import { pushToast } from "../../../../components/Toasts/Toasts";

type Status = {
  installed: boolean;
  connected: boolean;
  update: "extension" | "tori" | null;
  store: string;
  browsers: { name: string; installed: boolean }[];
};

// Polled, since nothing tells the window when a browser starts or drops the host.
const POLL_MS = 2000;

export default function BrowserPane(props: PaneProps) {
  const [status, setStatus] = createSignal<Status | null>(null);

  const load = () =>
    void invoke<Status>("browser_status")
      .then(setStatus)
      .catch(() => setStatus((s) => s && { ...s, connected: false }));

  onMount(() => {
    load();
    const poll = setInterval(load, POLL_MS);
    window.addEventListener("focus", load);
    onCleanup(() => {
      clearInterval(poll);
      window.removeEventListener("focus", load);
    });
  });

  const install = () =>
    void invoke("browser_install")
      .catch((e) => pushToast(`The browser extension was not installed: ${String(e)}`))
      .finally(load);

  const revoke = () =>
    void invoke("browser_revoke")
      .catch((e) => pushToast(`The browser extension was not revoked: ${String(e)}`))
      .finally(load);

  const getExtension = (url: string) =>
    void invoke("plugin:opener|open_url", { url }).catch((e) =>
      pushToast(`The Chrome Web Store did not open: ${String(e)}`),
    );

  const connection = () => {
    const s = status();
    if (!s?.installed) return "Not installed";
    if (s.update === "extension") return "Update the extension";
    if (s.update === "tori") return "Update Tori";
    return s.connected ? "Connected" : "Not connected";
  };

  const browsers = () => status()?.browsers ?? [];

  return (
    <Group {...props} title="Browser extension" ids={idsIn("browser")}>
      <Row {...props} id="browser-found" label="Browsers">
        <span>{browsers().length === 0 ? "None found" : `${browsers().length}`}</span>
      </Row>
      <Show when={props.shown("browser-found")}>
        <For each={browsers()}>
          {(b) => (
            <div class={styles.row}>
              <span class={styles.label}>{b.name}</span>
              <div class={styles.control}>
                <span>{b.installed ? "Installed" : "Not installed"}</span>
              </div>
            </div>
          )}
        </For>
      </Show>

      <Row {...props} id="browser-install" label="Install">
        <Button size="sm" disabled={browsers().length === 0} onClick={install}>
          {status()?.installed ? "Install again" : "Install"}
        </Button>
      </Row>

      <Row {...props} id="browser-store" label="Extension">
        <Button size="sm" disabled={!status()} onClick={() => getExtension(status()!.store)}>
          Get the extension
        </Button>
      </Row>

      <Row {...props} id="browser-status" label="Connected">
        <span role="status">{connection()}</span>
      </Row>

      <Row {...props} id="browser-revoke" label="Revoke">
        <Button size="sm" variant="danger" disabled={!status()?.installed} onClick={revoke}>
          Revoke
        </Button>
      </Row>
    </Group>
  );
}

import { createSignal, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Group, Row, idsIn, rowLabelId, type PaneProps } from "../../components/paneKit";
import styles from "../../Settings.module.css";
import { loadSettings, settings, type Settings } from "../../settingsStore";
import Switch from "../../../../components/Switch/Switch";
import Select, { type SelectOption } from "../../../../components/Select/Select";
import { pushToast } from "../../../../components/Toasts/Toasts";

/** Mirrors `remote::Status` in src-tauri/src/rpc/remote.rs. */
type RemoteStatus = { state: "off" } | { state: "listening"; url: string } | { state: "failed"; error: string };

/** Mirrors `remote::Interface` in src-tauri/src/rpc/remote.rs. */
type Interface = { name: string; address: string; kind: "lan" | "tailscale" | "loopback" };

const [status, setStatus] = createSignal<RemoteStatus>({ state: "off" });

let saving: Promise<void> = Promise.resolve();

// Not through `set_settings`: Rust owns this block. Chained, and each change
// reloads the store before the next builds on it, so two quick changes never
// send the first one's stale value back. A change to what is already stored is
// dropped: the switch fires `onChange` when a reload moves its `checked`, and
// sending that on would reload again, forever.
function setRemote(patch: Partial<Settings["remote"]>) {
  saving = saving
    .then(async () => {
      const next = { ...settings.remote, ...patch };
      const now = settings.remote;
      if (next.enabled === now.enabled && next.address === now.address && next.port === now.port) return;
      setStatus(await invoke<RemoteStatus>("remote_set", { remote: next }));
      await loadSettings();
    })
    .catch((e) => pushToast(`Remote access did not change: ${String(e)}`));
}

function describe(s: RemoteStatus): string {
  switch (s.state) {
    case "off":
      return "Off";
    case "listening":
      return `Listening on ${s.url}`;
    case "failed":
      return `Not listening: ${s.error}`;
  }
}

function optionFor(i: Interface): SelectOption {
  const where = i.kind === "tailscale" ? "Tailscale" : i.kind === "loopback" ? "this Mac only" : i.name;
  return { value: i.address, label: `${i.address} (${where})` };
}

export default function RemotePane(props: PaneProps) {
  const [interfaces, setInterfaces] = createSignal<Interface[]>([]);
  onMount(() => {
    void invoke<Interface[]>("remote_interfaces").then(setInterfaces).catch(() => {});
    void invoke<RemoteStatus>("remote_status").then(setStatus).catch(() => {});
  });

  const options = (): SelectOption[] => {
    const found = interfaces().map(optionFor);
    const stored = settings.remote.address;
    return stored && !found.some((o) => o.value === stored)
      ? [...found, { value: stored, label: `${stored} (not on this Mac)` }]
      : found;
  };

  return (
    <Group {...props} title="Remote access" ids={idsIn("remote")}>
      <Row {...props} id="remote-on" label="Remote access">
        <Switch
          checked={settings.remote.enabled}
          onChange={(enabled) => setRemote({ enabled })}
          aria-label="Remote access"
        />
      </Row>

      <Row {...props} id="remote-address" label="Listen on">
        <Select
          options={options()}
          value={settings.remote.address ?? ""}
          placeholder="Pick an address"
          onChange={(address) => setRemote({ address })}
          aria-labelledby={rowLabelId("remote-address")}
        />
      </Row>

      <Row {...props} id="remote-port" label="Port">
        <input
          type="number"
          min="1024"
          max="65535"
          aria-label="Port"
          class={`${styles.input} ${styles.numField}`}
          value={settings.remote.port}
          onChange={(e) => {
            const port = Math.round(Number(e.currentTarget.value));
            if (port >= 1024 && port <= 65535) setRemote({ port });
            else e.currentTarget.value = String(settings.remote.port);
          }}
        />
      </Row>

      <Row {...props} id="remote-status" label="Status">
        <span role="status">{describe(status())}</span>
      </Row>
    </Group>
  );
}

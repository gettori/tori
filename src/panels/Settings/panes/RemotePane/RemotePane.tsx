import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Group, Row, idsIn, rowLabelId, type PaneProps } from "../../components/paneKit";
import styles from "../../Settings.module.css";
import { settings } from "../../settingsStore";
import {
  remoteStatus as status,
  setRemote,
  setRemoteStatus as setStatus,
  type Device,
  type RemoteStatus,
} from "../../../../utils/remoteAccess";
import Switch from "../../../../components/Switch/Switch";
import Select, { type SelectOption } from "../../../../components/Select/Select";
import Button from "../../../../components/Button/Button";
import { pushToast } from "../../../../components/Toasts/Toasts";

/** Mirrors `remote::Interface` in src-tauri/src/rpc/remote.rs. */
type Interface = { name: string; address: string; kind: "tailscale" | "loopback" };

/** Mirrors `remote::Tailscale` in src-tauri/src/rpc/remote.rs. */
type Tailscale = { state: "missing" } | { state: "stopped" } | { state: "connected"; address: string };

/** Mirrors `PairingOffer` in src-tauri/src/rpc/mod.rs. */
type Offer = { code: string; url: string; uri: string; expires_ms: number; svg: string };

/** Mirrors `pairing::Ended` in src-tauri/src/rpc/pairing.rs, plus the expiry only the pane watches. */
type Ended = "used" | "burned" | "cancelled" | "expired";

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

const ENDED: Record<Ended, string> = {
  used: "Paired.",
  burned: "Too many wrong codes; the code no longer works.",
  cancelled: "Pairing cancelled.",
  expired: "The code expired.",
};

function describeTailscale(t: Tailscale): string {
  switch (t.state) {
    case "missing":
      return "Not installed";
    case "stopped":
      return "Not connected";
    case "connected":
      return `Connected as ${t.address}`;
  }
}

function remaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function pairedOn(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function optionFor(i: Interface): SelectOption {
  const where = i.kind === "tailscale" ? "Tailscale" : "this Mac only";
  return { value: i.address, label: `${i.address} (${where})` };
}

export default function RemotePane(props: PaneProps) {
  const [interfaces, setInterfaces] = createSignal<Interface[]>([]);
  const [devices, setDevices] = createSignal<Device[]>([]);
  const [tailscale, setTailscale] = createSignal<Tailscale | null>(null);
  const [offer, setOffer] = createSignal<Offer | null>(null);
  const [ended, setEnded] = createSignal<Ended | null>(null);
  const [now, setNow] = createSignal(Date.now());

  const loadDevices = () =>
    void invoke<Device[]>("devices_list")
      .then(setDevices)
      .catch(() => {});
  const end = (why: Ended) => {
    setOffer(null);
    setEnded(why);
  };

  // Also on focus: the user leaves to install or sign in to Tailscale and
  // comes back, and its address joins the picker only then.
  const loadNetwork = () => {
    void invoke<Interface[]>("remote_interfaces")
      .then(setInterfaces)
      .catch(() => {});
    void invoke<Tailscale>("remote_tailscale")
      .then(setTailscale)
      .catch(() => {});
  };

  onMount(() => {
    loadNetwork();
    window.addEventListener("focus", loadNetwork);
    void invoke<RemoteStatus>("remote_status")
      .then(setStatus)
      .catch(() => {});
    loadDevices();
    const unlisten = listen<{ ended: Ended | null }>("remote://devices", (e) => {
      loadDevices();
      if (e.payload.ended && offer()) end(e.payload.ended);
    });
    const tick = setInterval(() => {
      setNow(Date.now());
      const live = offer();
      if (live && Date.now() >= live.expires_ms) end("expired");
    }, 1000);
    onCleanup(() => {
      clearInterval(tick);
      window.removeEventListener("focus", loadNetwork);
      void unlisten.then((f) => f());
      // A code left live after the pane closes is one nobody is watching.
      if (offer()) void invoke("pairing_cancel");
    });
  });

  const startPairing = () => {
    setEnded(null);
    invoke<Offer>("pairing_start")
      .then((o) => {
        setNow(Date.now());
        setOffer(o);
      })
      .catch((e) => pushToast(`Pairing did not start: ${String(e)}`));
  };

  const revoke = (d: Device) =>
    void invoke("device_revoke", { id: d.id }).catch((e) => pushToast(`${d.name} was not revoked: ${String(e)}`));

  const options = (): SelectOption[] => {
    const found = interfaces().map(optionFor);
    const stored = settings.remote.address;
    return stored && !found.some((o) => o.value === stored)
      ? [...found, { value: stored, label: `${stored} (not available)` }]
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

      <Row {...props} id="remote-tailscale" label="Tailscale">
        <Show when={tailscale()}>
          {(t) => (
            <>
              <span role="status">{describeTailscale(t())}</span>
              <Show when={t().state !== "connected"}>
                <Button
                  size="sm"
                  onClick={() =>
                    void invoke("tailscale_open").catch((e) => pushToast(`Tailscale did not open: ${String(e)}`))
                  }
                >
                  {t().state === "missing" ? "Get Tailscale" : "Open Tailscale"}
                </Button>
              </Show>
            </>
          )}
        </Show>
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

      <Row {...props} id="remote-pair" label="Pair a device">
        <Show
          when={offer()}
          fallback={
            <Button size="sm" disabled={status().state !== "listening"} onClick={startPairing}>
              Pair a device
            </Button>
          }
        >
          <Button size="sm" onClick={() => void invoke("pairing_cancel")}>
            Cancel
          </Button>
        </Show>
      </Row>
      <Show when={props.shown("remote-pair")}>
        <Show when={offer()}>
          {(o) => (
            <div class={styles.pairing}>
              {/* Rust renders the SVG from a URI it built, so nothing typed reaches it. */}
              <div class={styles.pairQr} innerHTML={o().svg} role="img" aria-label="Pairing QR code" />
              <div class={styles.pairText}>
                <span class={styles.pairCode}>{o().code}</span>
                <span>{o().url}</span>
                <span>Expires in {remaining(o().expires_ms - now())}</span>
              </div>
            </div>
          )}
        </Show>
        <Show when={ended()}>
          {(why) => (
            <div class={styles.note} role="status">
              {ENDED[why()]}
            </div>
          )}
        </Show>
      </Show>

      <Row {...props} id="remote-devices" label="Paired devices">
        <span>{devices().length === 0 ? "None" : `${devices().length}`}</span>
      </Row>
      <Show when={props.shown("remote-devices")}>
        <For each={devices()}>
          {(d) => (
            <div class={styles.row}>
              <span class={styles.label}>{d.name}</span>
              <div class={styles.control}>
                <Button size="sm" variant="danger" aria-label={`Revoke ${d.name}`} onClick={() => revoke(d)}>
                  Revoke
                </Button>
              </div>
              <div class={styles.hint}>Paired {pairedOn(d.created_ms)}</div>
            </div>
          )}
        </For>
      </Show>
    </Group>
  );
}

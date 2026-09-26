import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Smartphone } from "lucide-solid";
import Button from "../Button/Button";
import Icon from "../Icon/Icon";
import Popover from "../Popover/Popover";
import Switch from "../Switch/Switch";
import { pushToast } from "../Toasts/Toasts";
import { settings } from "../../panels/Settings/settingsStore";
import { setRemote, type Device } from "../../utils/remoteAccess";
import styles from "./PhoneIndicator.module.css";

export default function PhoneIndicator() {
  const [devices, setDevices] = createSignal<Device[]>([]);
  const [open, setOpen] = createSignal(false);
  let anchor: HTMLButtonElement | undefined;

  const load = () => void invoke<Device[]>("devices_list").then(setDevices).catch(() => {});
  onMount(() => {
    load();
    const unlisten = listen("remote://devices", load);
    onCleanup(() => void unlisten.then((f) => f()));
  });

  const connected = () => devices().filter((d) => d.connected).length;
  const revoke = (d: Device) =>
    void invoke("device_revoke", { id: d.id }).catch((e) => pushToast(`${d.name} was not revoked: ${String(e)}`));

  return (
    <Show when={devices().length > 0}>
      <Button
        ref={anchor}
        class="topbar-phone"
        data-lit={connected() > 0}
        variant="ghost"
        aria-label="Phones"
        aria-expanded={open()}
        tooltip={connected() > 0 ? `${connected()} connected` : "No phone connected"}
        onClick={() => setOpen(!open())}
        icon={<Icon icon={Smartphone} />}
      />
      <Show when={open()}>
        <Popover anchorEl={anchor} placement="bottom-end" onClose={() => setOpen(false)} aria-label="Phones">
          <div class={styles.card}>
            <For each={devices()}>
              {(d) => (
                <div class={styles.device}>
                  <span class={styles.dot} classList={{ [styles.on]: d.connected }} />
                  <span class={styles.name}>{d.name}</span>
                  <span class={styles.state}>{d.connected ? "Connected" : "Offline"}</span>
                  <Button size="sm" variant="danger" aria-label={`Revoke ${d.name}`} onClick={() => revoke(d)}>
                    Revoke
                  </Button>
                </div>
              )}
            </For>
            <div class={styles.remote}>
              <Switch
                label="Remote access"
                checked={settings.remote.enabled}
                onChange={(enabled) => setRemote({ enabled })}
              />
            </div>
          </div>
        </Popover>
      </Show>
    </Show>
  );
}

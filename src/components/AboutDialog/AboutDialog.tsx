import { For, Show, createResource, createSignal, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Check, Copy } from "lucide-solid";
import Dialog from "../Dialog/Dialog";
import Button from "../Button/Button";
import Icon from "../Icon/Icon";
import { copyText } from "../../utils/clipboard";
import { CHECK_UPDATES, emit } from "../../utils/events";
import styles from "./AboutDialog.module.css";

type AboutInfo = { version: string; commit: string | null };

const LINKS: [string, string][] = [
  ["Website", "https://gettori.app/"],
  ["Documentation", "https://gettori.app/docs/"],
  ["Release Notes", "https://gettori.app/changelog/"],
  ["GitHub", "https://github.com/gettori/tori"],
];

const openUrl = (url: string) => void invoke("plugin:opener|open_url", { url }).catch(() => {});

/**
 * Tori's About box, in place of the stock macOS panel, which takes text and an
 * icon but no controls: nothing to copy the version from, no links to follow.
 */
export default function AboutDialog(props: { onClose: () => void }) {
  const [info] = createResource(() => invoke<AboutInfo>("about_info").catch(() => null));
  const [copied, setCopied] = createSignal(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(copiedTimer));

  const versionLine = () => {
    const i = info();
    return i ? `Tori ${i.version}${i.commit ? ` (${i.commit})` : ""}` : "";
  };

  const copyVersion = async () => {
    if (!(await copyText(versionLine()))) return;
    setCopied(true);
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => setCopied(false), 1500);
  };

  const checkUpdates = () => {
    props.onClose();
    emit(CHECK_UPDATES);
  };

  return (
    <Dialog
      open
      size="sheet"
      title="About Tori"
      titleHidden
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={checkUpdates}>Check for Updates</Button>
          <Button variant="primary" onClick={props.onClose}>
            Done
          </Button>
        </>
      }
    >
      <div class={styles.content}>
        <img class={styles.icon} src="/favicon.png" alt="" />
        <h2 class={styles.name}>Tori</h2>
        <p class={styles.tagline}>A cockpit for the coding agents you already run.</p>
        <Show when={info()}>
          {(i) => (
            <button
              type="button"
              class={styles.version}
              aria-label={copied() ? "Version copied" : `Copy version, ${versionLine()}`}
              onClick={() => void copyVersion()}
            >
              <span>Version {i().version}</span>
              <Show when={i().commit}>
                <span class={styles.commit}>{i().commit}</span>
              </Show>
              <Icon icon={copied() ? Check : Copy} class={styles.copyIcon} />
            </button>
          )}
        </Show>
        <nav class={styles.links} aria-label="Tori links">
          <For each={LINKS}>
            {([label, url]) => (
              <button type="button" class={styles.link} onClick={() => openUrl(url)}>
                {label}
              </button>
            )}
          </For>
        </nav>
        <p class={styles.legal}>Copyright 2026 Fazlul Haque. Licensed under the Apache License 2.0.</p>
      </div>
    </Dialog>
  );
}

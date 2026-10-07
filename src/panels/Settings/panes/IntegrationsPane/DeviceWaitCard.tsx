import { Show } from "solid-js";
import { Check } from "lucide-solid";
import Button from "../../../../components/Button/Button";
import Icon from "../../../../components/Icon/Icon";
import { openInBrowser } from "./deviceFlow";
import type { DevicePrompt } from "../../../../utils/forgeTypes";
import cards from "./ForgeSection.module.css";
import { MOD_WORD } from "../../../../utils/platform";

function codeGroups(code: string): [string, string] {
  const chars = code.replace(/[^0-9A-Za-z]/g, "");
  const half = Math.ceil(chars.length / 2);
  return [chars.slice(0, half), chars.slice(half)];
}

function mmss(ms: number): string {
  const secs = Math.max(0, Math.ceil(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(secs / 60))}:${pad(secs % 60)}`;
}

/** The code to paste and the way back to the page, while a browser sign-in
 *  waits on the host. */
export default function DeviceWaitCard(props: {
  host: string;
  /** Null until the host has issued a code. */
  prompt: DevicePrompt | null;
  remainingMs: number;
  clipboardOk: boolean;
  onCopyAgain: () => void;
  onCancel: () => void;
}) {
  const openLink = (e: MouseEvent, url: string) => {
    e.preventDefault();
    openInBrowser(url);
  };

  return (
    <div class={cards.card} data-tone="brand">
      <div class={cards.band} data-tone="brand">
        <span class={cards.pulse} aria-hidden="true" />
        <span class={cards.bandTitle}>Waiting for {props.host}</span>
        <span class={cards.spacer} />
        <Show when={props.prompt}>
          <span class={cards.meta} data-testid="expires">
            expires in {mmss(props.remainingMs)}
          </span>
        </Show>
      </div>
      <div class={cards.wait}>
        <Show when={props.prompt} fallback={<div class={cards.lead}>Asking {props.host} for a code...</div>}>
          {(p) => (
            <>
              <div class={cards.lead}>The page is open in your browser. Paste this, then come back.</div>
              <div class={cards.code} data-testid="device-code">
                <span>{codeGroups(p().userCode)[0]}</span>
                <span class={cards.codeBar} aria-hidden="true" />
                <span>{codeGroups(p().userCode)[1]}</span>
              </div>
              <Show
                when={props.clipboardOk}
                fallback={
                  <div class={cards.copied}>
                    <Button variant="primary" size="xs" onClick={() => props.onCopyAgain()}>
                      Copy the code
                    </Button>
                  </div>
                }
              >
                <div class={cards.copied} data-testid="clipboard-confirmation">
                  <span class={cards.check} aria-hidden="true">
                    <Icon icon={Check} size={10} strokeWidth={2.5} />
                  </span>
                  <span>
                    <span class={cards.copiedWord}>Already on your clipboard</span>, {MOD_WORD}+V is all you need
                  </span>
                </div>
              </Show>
            </>
          )}
        </Show>
      </div>
      <div class={cards.footer}>
        <span class={`${cards.footNote} ${cards.recovery}`}>
          Closed the page, or the clipboard is blocked?{" "}
          <Show when={props.prompt}>
            {(p) => (
              <>
                <a class={cards.link} href={p().verificationUri} onClick={(e) => openLink(e, p().verificationUri)}>
                  Reopen {p().verificationUri.replace(/^https?:\/\//, "")}
                </a>{" "}
                <span class={cards.nowrap}>
                  {"· "}
                  <button type="button" class={cards.link} onClick={() => props.onCopyAgain()}>
                    Copy again
                  </button>
                </span>
              </>
            )}
          </Show>
        </span>
        <Button variant="ghost" size="xs" onClick={() => props.onCancel()}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

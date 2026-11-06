import { Show, createEffect, createSignal, on } from "solid-js";
import { ChevronRight, Keyboard, Link, QrCode } from "lucide-solid";
import logo from "../../src-tauri/icons/128x128@2x.png";
import Icon from "../../src/components/Icon/Icon";
import { pair, parsePairLink, type Saved } from "./remote";
import shell from "./shell.module.css";

const PHONE_NAME = "Phone";

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export default function Pair(props: {
  onPaired: (saved: Saved) => void;
  notice: string | null;
  link: { url: string; code: string } | null;
}) {
  const [url, setUrl] = createSignal("");
  const [code, setCode] = createSignal("");
  const [name, setName] = createSignal(PHONE_NAME);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [linked, setLinked] = createSignal(false);

  const fromLink = (text: string) => {
    const link = parsePairLink(text.trim());
    if (!link) return;
    setUrl(link.url);
    setCode(link.code);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      props.onPaired(await pair(url().trim(), code().trim(), name().trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  createEffect(
    on(
      () => props.link,
      (link) => {
        if (!link) return;
        // A link is only an address and a code: a page or a QR code the user
        // did not mean to scan must not start a pairing on its own.
        setUrl(link.url);
        setCode(link.code);
        setLinked(true);
      },
    ),
  );

  return (
    <form
      class={shell.pair}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <header class={shell.pairHead}>
        <img class={shell.pairLogo} src={logo} alt="" />
        <h1 class={shell.pairTitle}>Pair with Tori</h1>
        <p class={shell.pairLead}>Connect this phone to Tori on your Mac.</p>
      </header>
      <Show when={props.notice}>
        <p class={shell.notice}>{props.notice}</p>
      </Show>
      <div class={shell.pairCard}>
        <span class={shell.pairCardIcon}>
          <Icon icon={QrCode} size={20} strokeWidth={1.9} />
        </span>
        <span class={shell.pairCardText}>
          <strong>Scan the code on the Mac</strong>
          <span>
            In Tori on the Mac, open Settings, Remote, Pair a device, and scan the code with this phone's camera.
          </span>
        </span>
      </div>
      <Show when={linked() && url()}>
        <button class={shell.pairButton} type="submit" disabled={busy() || !code()}>
          <Icon icon={Link} size={15} strokeWidth={2.4} />
          Pair with {hostOf(url())}
        </button>
      </Show>
      <Show when={busy()}>
        <p class={shell.notice}>Waiting for the Mac to allow this phone</p>
      </Show>
      <Show when={error()}>
        <p class={shell.notice}>{error()}</p>
      </Show>
      <details class={shell.typed} open={!!error()}>
        <summary>
          <Icon icon={Keyboard} size={17} strokeWidth={1.9} />
          <span>Type the address and code</span>
          <Icon icon={ChevronRight} size={16} strokeWidth={2} class={shell.typedChevron} />
        </summary>
        <div class={shell.typedBody}>
          <label class={shell.field}>
            Link
            <input class={shell.mono} placeholder="tori://pair?..." onInput={(e) => fromLink(e.currentTarget.value)} />
          </label>
          <label class={shell.field}>
            Address
            <input
              class={shell.mono}
              value={url()}
              placeholder="ws://192.168.1.10:7878"
              onInput={(e) => setUrl(e.currentTarget.value)}
            />
          </label>
          <label class={shell.field}>
            Code
            <input
              class={shell.mono}
              value={code()}
              placeholder="XXXX-XXXX"
              autocapitalize="characters"
              onInput={(e) => setCode(e.currentTarget.value)}
            />
          </label>
          <label class={shell.field}>
            This phone's name
            <input value={name()} onInput={(e) => setName(e.currentTarget.value)} />
          </label>
          <button class={shell.pairButton} type="submit" disabled={busy() || !url() || !code()}>
            <Icon icon={Link} size={15} strokeWidth={2.4} />
            {busy() ? "Pairing" : "Pair"}
          </button>
        </div>
      </details>
    </form>
  );
}

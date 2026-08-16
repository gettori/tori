import { createSignal, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import Button from "../../../../components/Button/Button";
import { copyText } from "../../../../utils/clipboard";
import { settings, saveSettings } from "../../settingsStore";
import type { AuthState } from "../../../../utils/forgeTypes";
import { noteForgeAuth } from "../../../../utils/forgeStatus";
import styles from "../../Settings.module.css";
import Switch from "../../../../components/Switch/Switch";

// The GitHub account section: sign in by device flow, see who you are signed in
// as, sign out, and the integration's kill switch.
//
// Four surfaces, not three. Alongside signed-out / pending / signed-in there is
// **suspect**: a stored token the forge rejected. It is deliberately not
// rendered as signed-out, because the token is still there and the user's next
// action is different ("sign back in", not "sign in"). Showing it as signed-out
// would also imply the credential had been discarded, which is exactly what
// Sway does not do on a 401.

type PollReport =
  | { kind: "authorized"; login: string }
  | { kind: "pending"; nextIntervalSecs: number }
  | { kind: "denied" }
  | { kind: "expired" };

type DevicePrompt = {
  userCode: string;
  verificationUri: string;
  expiresInSecs: number;
  intervalSecs: number;
};

type ForgeError = { kind: string; message: string };

const asForgeError = (e: unknown): ForgeError =>
  typeof e === "object" && e !== null && "kind" in e
    ? (e as ForgeError)
    : { kind: "transport", message: String(e) };

export default function GithubSection() {
  const [auth, setAuth] = createSignal<AuthState>({ kind: "signedOut" });
  const [prompt, setPrompt] = createSignal<DevicePrompt | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);
  const [configured, setConfigured] = createSignal(true);

  // The poll timer is the one piece of state that must not outlive the panel: a
  // device flow left running would keep hitting GitHub after the user closed
  // Settings, and on a `slow_down` that is exactly how a throttle becomes a
  // block.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopPolling = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  onCleanup(() => {
    stopPolling();
    if (prompt()) void invoke("github_device_cancel");
  });

  const refresh = async () => {
    const state = await invoke<AuthState>("github_auth_state");
    setAuth(state);
    // Sign-in and sign-out both happen here and nowhere else, so this is the
    // one place that knows the moment the credential changes. Telling the poll
    // store directly is what makes the sidebar's chips appear on sign-in and
    // vanish on sign-out, rather than at whatever the next focus happens to be.
    noteForgeAuth(state);
    setConfigured(await invoke<boolean>("github_is_configured"));
  };
  void refresh();

  async function signIn() {
    setError(null);
    try {
      const p = await invoke<DevicePrompt>("github_device_start");
      setPrompt(p);
      // Opening the page for them is the whole point of the flow: the code is
      // useless without it.
      window.open(p.verificationUri, "_blank");
      schedule(p.intervalSecs);
    } catch (e) {
      setError(asForgeError(e).message);
    }
  }

  // The interval comes from the server on every turn, so a `slow_down` actually
  // slows this caller down instead of being noted and ignored.
  function schedule(seconds: number) {
    stopPolling();
    timer = setTimeout(() => void pollOnce(), seconds * 1000);
  }

  async function pollOnce() {
    try {
      const report = await invoke<PollReport>("github_device_poll");
      switch (report.kind) {
        case "authorized":
          setPrompt(null);
          stopPolling();
          await refresh();
          break;
        case "pending":
          schedule(report.nextIntervalSecs);
          break;
        case "denied":
          setPrompt(null);
          stopPolling();
          setError("Sign-in was declined on GitHub.");
          break;
        case "expired":
          setPrompt(null);
          stopPolling();
          setError("That code expired. Start again.");
          break;
      }
    } catch (e) {
      setPrompt(null);
      stopPolling();
      setError(asForgeError(e).message);
    }
  }

  async function signOut() {
    setError(null);
    try {
      await invoke("github_sign_out");
      await refresh();
    } catch (e) {
      setError(asForgeError(e).message);
    }
  }

  async function copyCode() {
    const p = prompt();
    if (!p) return;
    setCopied(await copyText(p.userCode));
  }

  // Narrowed once each rather than cast at every use: the state is a tagged
  // union, and repeating the cast is what lets one of them drift to the wrong tag.
  /** Whether the integration has an account to act as. **Suspect counts**: the
   *  token is still stored and the setting still means something, so switching
   *  it off is still a choice the user can make while they sort the sign-in
   *  out. */
  const connected = () => auth().kind === "signedIn" || auth().kind === "suspect";

  const signedInLogin = () => {
    const a = auth();
    return a.kind === "signedIn" ? a.login : "";
  };
  const suspectLogin = () => {
    const a = auth();
    return a.kind === "suspect" ? a.login : null;
  };

  const setEnabled = (enabled: boolean) =>
    saveSettings({ ...settings, github: { ...settings.github, enabled } });

  return (
    <section class={styles.section}>
      <div class={styles.sectionTitle}>
        <span>GitHub</span>
        <span class={styles.sectionRule} />
      </div>

      <Show when={!configured()}>
        <div class={styles.note}>
          Sign-in is unavailable in this build: no OAuth app is configured.
        </div>
      </Show>

      {/* Signed out, and no flow running. A card rather than a row, because
          there is nothing here to set yet: the one thing to do is connect an
          account, and what that buys is worth a sentence beside the button. */}
      <Show when={configured() && auth().kind === "signedOut" && !prompt()}>
        <div class={styles.connect}>
          {/* Two letters, not a logo: lucide dropped its brand icons, and
              vendoring a mark to fill a 34px tile is a licence question for a
              decoration. */}
          <div class={styles.monogram} aria-hidden="true">
            GH
          </div>
          <div class={styles.connectMain}>
            <div class={styles.connectTitle}>Not signed in</div>
            <div class={styles.cardStatus}>
              Pull requests, checks and review threads appear next to the branch they belong to.
            </div>
          </div>
          <Button variant="primary" onClick={() => void signIn()}>
            Sign in to GitHub
          </Button>
        </div>
      </Show>

      {/* A flow is running: show the code and where to type it. */}
      <Show when={prompt()}>
        {(p) => (
          <>
            <div class={styles.row}>
              <label class={styles.label}>Your code</label>
              <div class={styles.control}>
                <code data-testid="device-code">{p().userCode}</code>{" "}
                <Button variant="ghost" size="xs" onClick={() => void copyCode()}>
                  {copied() ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
            <div class={styles.note}>
              Enter it at{" "}
              <a
                href={p().verificationUri}
                onClick={(e) => {
                  e.preventDefault();
                  window.open(p().verificationUri, "_blank");
                }}
              >
                {p().verificationUri}
              </a>
              . Waiting for you to finish.
            </div>
          </>
        )}
      </Show>

      {/* Signed in. */}
      <Show when={auth().kind === "signedIn"}>
        <div class={styles.row}>
          <label class={styles.label}>Account</label>
          <div class={styles.control}>
            Signed in as {signedInLogin() || "GitHub"}{" "}
            <Button variant="ghost" size="xs" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </Show>

      {/* Suspect: the token is still stored, so this is "sign back in", not
          "sign in", and naming the account is what makes that actionable. */}
      <Show when={auth().kind === "suspect"}>
        <div class={styles.row}>
          <label class={styles.label}>Account</label>
          <div class={styles.control} data-testid="suspect-notice">
            GitHub rejected the stored sign-in
            {suspectLogin() ? ` for ${suspectLogin()}` : ""}. Updates are paused until you sign in
            again.{" "}
            <Button size="xs" onClick={() => void signIn()}>
              Sign in again
            </Button>
          </div>
        </div>
      </Show>

      <Show when={error()}>
        <div class={styles.note} data-testid="github-error">
          {error()}
        </div>
      </Show>

      {/* The one actual setting here, and it depends on the card above. Without
          an account it stays on screen and inert rather than disappearing:
          hidden, "where did that setting go?" has no answer, and the row is
          also the only place that says what connecting an account is *for*. */}
      <div classList={{ [styles.inert]: !connected() }}>
        <div class={styles.row}>
          {/* Chrome rather than a form label, the same way `ToggleRow`'s is: the
              grid makes it a sibling of the control, and the shared `Switch`
              generates its own input id, so there is nothing to point `for` at.
              The control names itself instead. */}
          <label class={styles.label}>Show pull requests and checks</label>
          <div class={styles.control}>
            <Switch
              aria-label="Show pull requests and checks"
              checked={settings.github.enabled}
              disabled={!connected()}
              onChange={(v) => void setEnabled(v)}
            />
          </div>
          <Show when={!connected()}>
            <div class={styles.hint}>Available once an account is connected.</div>
          </Show>
        </div>
      </div>
    </section>
  );
}

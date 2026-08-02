import { createSignal, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import Button from "../../components/Button/Button";
import { copyText } from "../../utils/clipboard";
import { settings, saveSettings } from "./settingsStore";
import type { AuthState } from "../../utils/forgeTypes";
import styles from "./Settings.module.css";

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
    setAuth(await invoke<AuthState>("github_auth_state"));
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
      <div class={styles.sectionTitle}>GitHub</div>

      <Show when={!configured()}>
        <div class={styles.row}>
          <div class={styles.control}>
            Sign-in is unavailable in this build: no OAuth app is configured.
          </div>
        </div>
      </Show>

      {/* Signed out, and no flow running. */}
      <Show when={configured() && auth().kind === "signedOut" && !prompt()}>
        <div class={styles.row}>
          <label class={styles.label}>Account</label>
          <div class={styles.control}>
            <Button onClick={() => void signIn()}>Sign in to GitHub</Button>
          </div>
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
            <div class={styles.row}>
              <div class={styles.control}>
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
        <div class={styles.row}>
          <div class={styles.control} data-testid="github-error">
            {error()}
          </div>
        </div>
      </Show>

      <div class={styles.row}>
        <label class={styles.label}>Integration</label>
        <div class={styles.control}>
          <label>
            <input
              type="checkbox"
              checked={settings.github.enabled}
              onChange={(e) => void setEnabled(e.currentTarget.checked)}
            />{" "}
            Show pull requests and checks
          </label>
        </div>
      </div>
    </section>
  );
}

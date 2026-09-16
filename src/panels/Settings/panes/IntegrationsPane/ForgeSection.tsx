import { createSignal, For, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import Button from "../../../../components/Button/Button";
import Select from "../../../../components/Select/Select";
import Switch from "../../../../components/Switch/Switch";
import ConfirmDialog, { type ConfirmOpts, type ConfirmReq } from "../../../../components/Dialogs/ConfirmDialog";
import { copyText } from "../../../../utils/clipboard";
import { settings, saveSettings } from "../../settingsStore";
import {
  forgeAccountName,
  forgeErrorMessage,
  type AuthState,
  type ForgeAccount,
  type ForgeHost,
  type ForgeProvider,
  type SignInRoutes,
} from "../../../../utils/forgeTypes";
import { noteForgeAccounts, resetForgeResolutions } from "../../../../utils/forgeStatus";
import styles from "../../Settings.module.css";
import cards from "./ForgeSection.module.css";

// A rejected account is **suspect**, not signed out: its token is still stored,
// so its action is "sign in again", and rendering it as signed out would imply
// Sway discarded a credential it deliberately kept.

type PollReport =
  | { kind: "authorized"; accountId: string; login: string }
  | { kind: "pending"; nextIntervalSecs: number }
  | { kind: "denied"; code: string }
  | { kind: "expired"; code: string };

type DevicePrompt = {
  userCode: string;
  verificationUri: string;
  expiresInSecs: number;
  intervalSecs: number;
};

type Draft = { provider: ForgeProvider; url: string; accountId: string | null };

const PROVIDERS: { value: ForgeProvider; label: string; url: string }[] = [
  { value: "github", label: "GitHub", url: "https://github.com" },
  { value: "gitlab", label: "GitLab", url: "https://gitlab.com" },
];

const STATUS_WORD: Record<AuthState["kind"], string> = {
  signedIn: "signed in",
  suspect: "rejected",
  signedOut: "signed out",
};

// Every account on a host shares its provider, so the first one names the family.
function family(host: ForgeHost): string {
  if (host.accounts[0]?.provider === "gitlab") return "GitLab";
  return host.host === "github.com" ? "GitHub" : "Enterprise";
}

// Day and month apart: newer ICU spells en-GB September "Sept", en-US keeps "Sep".
function rejection(host: string, rejectedAt: number | null): string {
  const at = rejectedAt === null ? null : new Date(rejectedAt * 1000);
  const on = at ? ` on ${at.getDate()} ${at.toLocaleDateString("en-US", { month: "short" })}` : "";
  return `${host} stopped accepting this token${on}. It is still stored, so signing in again replaces it in place.`;
}

const signedIn = (host: ForgeHost) => host.accounts.filter((a) => a.auth.kind === "signedIn");

export default function ForgeSection() {
  const [hosts, setHosts] = createSignal<ForgeHost[]>([]);
  const [draft, setDraft] = createSignal<Draft | null>(null);
  const [routes, setRoutes] = createSignal<SignInRoutes | null>(null);
  const [token, setToken] = createSignal("");
  const [appId, setAppId] = createSignal("");
  const [prompt, setPrompt] = createSignal<DevicePrompt | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [confirmReq, setConfirmReq] = createSignal<ConfirmReq | null>(null);
  const askConfirm = (opts: ConfirmOpts) =>
    new Promise<boolean>((resolve) => setConfirmReq({ ...opts, resolve }));
  const answerConfirm = (ok: boolean) => {
    const req = confirmReq();
    setConfirmReq(null);
    req?.resolve(ok);
  };

  // The poll timer is the one piece of state that must not outlive the panel: a
  // device flow left running would keep hitting the host after the user closed
  // Settings, and on a `slow_down` that is exactly how a throttle becomes a
  // block.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopPolling = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  onCleanup(() => {
    stopPolling();
    if (prompt()) void invoke("forge_device_cancel");
  });

  // Accounts change here and nowhere else, so this is the one place that knows
  // the moment they do. Telling the poll store directly is what makes the chips
  // appear on sign-in and vanish on removal, not at the next focus.
  const refresh = async () => {
    const list = await invoke<ForgeHost[]>("forge_accounts").catch(() => null);
    if (!Array.isArray(list)) return;
    setHosts(list);
    noteForgeAccounts(list.flatMap((h) => h.accounts));
  };
  void refresh();

  function openDraft(provider: ForgeProvider, url: string, accountId: string | null = null) {
    setError(null);
    setToken("");
    setAppId("");
    setRoutes(null);
    setDraft({ provider, url, accountId });
  }

  /** Both places routes arrive, so the application id field always shows what
   *  is stored for the host rather than what the last draft typed. */
  function noteRoutes(r: SignInRoutes) {
    setRoutes(r);
    setAppId(r.appId ?? "");
  }

  function closeDraft() {
    setDraft(null);
    setRoutes(null);
    setToken("");
  }

  async function loadRoutes(d: Draft) {
    setError(null);
    try {
      noteRoutes(
        await invoke<SignInRoutes>("forge_sign_in_routes", { provider: d.provider, baseUrl: d.url }),
      );
    } catch (e) {
      setError(forgeErrorMessage(e));
    }
  }

  async function saveAppId(d: Draft, r: SignInRoutes) {
    setError(null);
    try {
      noteRoutes(
        await invoke<SignInRoutes>("forge_set_app_id", {
          provider: d.provider,
          baseUrl: r.baseUrl,
          appId: appId(),
        }),
      );
    } catch (e) {
      setError(forgeErrorMessage(e));
    }
  }

  async function signInWithBrowser(provider: ForgeProvider, baseUrl: string, accountId: string | null = null) {
    setError(null);
    try {
      const p = await invoke<DevicePrompt>("forge_device_start", { provider, baseUrl, accountId });
      setPrompt(p);
      // Opening the page for them is the whole point of the flow: the code is
      // useless without it.
      window.open(p.verificationUri, "_blank");
      schedule(p.intervalSecs);
    } catch (e) {
      setError(forgeErrorMessage(e));
    }
  }

  // The interval comes from the server on every turn, so a `slow_down` actually
  // slows this caller down instead of being noted and ignored.
  function schedule(seconds: number) {
    stopPolling();
    timer = setTimeout(() => void pollOnce(), seconds * 1000);
  }

  async function pollOnce() {
    const end = (message: string | null) => {
      setPrompt(null);
      stopPolling();
      setError(message);
    };
    try {
      const report = await invoke<PollReport>("forge_device_poll");
      switch (report.kind) {
        case "authorized":
          end(null);
          closeDraft();
          await refresh();
          break;
        case "pending":
          schedule(report.nextIntervalSecs);
          break;
        case "denied":
          end("Sign-in was declined in the browser.");
          break;
        case "expired":
          end("That code expired. Start again.");
          break;
      }
    } catch (e) {
      end(forgeErrorMessage(e));
    }
  }

  async function addToken() {
    const d = draft();
    const r = routes();
    if (!d || !r) return;
    setError(null);
    setBusy(true);
    try {
      await invoke("forge_add_token", {
        provider: d.provider,
        baseUrl: r.baseUrl,
        token: token(),
        accountId: d.accountId,
      });
      closeDraft();
      await refresh();
    } catch (e) {
      setError(forgeErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  // Back through whichever rung the host offers: the browser where Sway has
  // one, otherwise the token form already pointed at this host.
  async function signInAgain(account: ForgeAccount) {
    setError(null);
    let r: SignInRoutes;
    try {
      r = await invoke<SignInRoutes>("forge_sign_in_routes", {
        provider: account.provider,
        baseUrl: account.baseUrl,
      });
    } catch (e) {
      setError(forgeErrorMessage(e));
      return;
    }
    if (r.deviceFlow) return signInWithBrowser(account.provider, r.baseUrl, account.id);
    openDraft(account.provider, r.baseUrl, account.id);
    noteRoutes(r);
  }

  // Rust answers with the whole list, so the row shows what was stored rather
  // than what the click assumed.
  async function setGitCredentials(host: ForgeHost, enabled: boolean) {
    setError(null);
    try {
      // With several accounts and no default, the switch would read on while
      // git still asked which account to use.
      const first = signedIn(host)[0];
      if (enabled && host.accounts.length > 1 && !host.defaultAccount && first) {
        await invoke("forge_set_default_account", { host: host.host, accountId: first.id });
        resetForgeResolutions();
      }
      const list = await invoke<ForgeHost[]>("forge_set_git_credentials", { host: host.host, enabled });
      if (Array.isArray(list)) setHosts(list);
    } catch (e) {
      setError(forgeErrorMessage(e));
    }
  }

  // A repo already resolved to the pick state keeps it until asked again.
  async function setDefaultAccount(host: string, accountId: string) {
    setError(null);
    try {
      const list = await invoke<ForgeHost[]>("forge_set_default_account", { host, accountId });
      if (Array.isArray(list)) setHosts(list);
      resetForgeResolutions();
    } catch (e) {
      setError(forgeErrorMessage(e));
    }
  }

  async function remove(host: string, account: ForgeAccount) {
    const ok = await askConfirm({
      title: `Remove ${forgeAccountName(account)} from ${host}?`,
      message: "Sway deletes the token it stored for this account.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await invoke("forge_remove_account", { accountId: account.id });
      await refresh();
    } catch (e) {
      setError(forgeErrorMessage(e));
    }
  }

  async function copyCode() {
    const p = prompt();
    if (!p) return;
    setCopied(await copyText(p.userCode));
  }

  const openLink = (e: MouseEvent, url: string) => {
    e.preventDefault();
    window.open(url, "_blank");
  };

  const connected = () => hosts().length > 0;
  const idle = () => !draft() && !prompt();
  const addTo = (host: ForgeHost) => {
    const first = host.accounts[0];
    if (first) openDraft(first.provider, first.baseUrl);
  };

  const setEnabled = (enabled: boolean) =>
    saveSettings({ ...settings, forge: { ...settings.forge, enabled } });

  return (
    <section class={styles.section}>
      <div class={styles.sectionTitle}>
        <span>GitHub and GitLab</span>
        <span class={styles.sectionRule} />
      </div>

      <div class={cards.stack}>
        <Show when={hosts().length === 0 && idle()}>
          <div class={cards.empty}>
            <div class={cards.emptyTitle}>No hosts connected</div>
            <div class={cards.emptyBody}>
              Connect a host and its pull requests, merge requests and checks show up beside the branch
              they belong to.
            </div>
            <div class={cards.emptyActions}>
              <Button variant="primary" onClick={() => openDraft("github", "https://github.com")}>
                Connect github.com
              </Button>
              <Button variant="ghost" onClick={() => openDraft("github", "https://github.com")}>
                Another host...
              </Button>
            </div>
          </div>
        </Show>

        <For each={hosts()}>
          {(host) => {
            const usable = () => signedIn(host);
            return (
              <div class={cards.card} data-testid="forge-host">
                <div class={cards.head}>
                  <span class={cards.host}>{host.host}</span>
                  <span class={cards.tag} data-family={family(host)}>
                    {family(host)}
                  </span>
                  <span class={cards.spacer} />
                  <Button
                    variant="ghost"
                    size="xs"
                    aria-label={`Add account on ${host.host}`}
                    onClick={() => addTo(host)}
                  >
                    Add account
                  </Button>
                </div>
                <For each={host.accounts}>
                  {(account) => (
                    <div
                      class={cards.account}
                      classList={{ [cards.rejected]: account.auth.kind === "suspect" }}
                      data-testid="forge-account"
                    >
                      <div class={cards.line}>
                        <span class={cards.dot} data-auth={account.auth.kind} aria-hidden="true" />
                        <span class={cards.login}>{forgeAccountName(account)}</span>
                        <span class={cards.word} data-auth={account.auth.kind}>
                          {STATUS_WORD[account.auth.kind]}
                        </span>
                        <Show when={account.auth.kind !== "signedIn"}>
                          <Button variant="primary" size="xs" onClick={() => void signInAgain(account)}>
                            Sign in again
                          </Button>
                        </Show>
                        <Button
                          variant="ghost"
                          size="xs"
                          class={cards.remove}
                          aria-label={`Remove ${forgeAccountName(account)}`}
                          onClick={() => void remove(host.host, account)}
                        >
                          Remove
                        </Button>
                      </div>
                      <Show when={account.auth.kind === "suspect"}>
                        <div class={cards.reason} data-testid="suspect-notice">
                          {rejection(host.host, account.rejectedAt)}
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
                <div class={cards.footer} classList={{ [cards.footerInert]: usable().length === 0 }}>
                  <div class={cards.footerLabel}>
                    <Show
                      when={host.accounts.length > 1}
                      fallback={<span>Use this account for git push and fetch</span>}
                    >
                      <span>Use for git push and fetch</span>
                      <Select
                        size="xs"
                        aria-label={`Account ${host.host} pushes and fetches as`}
                        placeholder="Choose account"
                        value={host.defaultAccount ?? ""}
                        options={usable().map((a) => ({ value: a.id, label: forgeAccountName(a) }))}
                        disabled={usable().length === 0}
                        onChange={(id) => void setDefaultAccount(host.host, id)}
                      />
                    </Show>
                  </div>
                  <Switch
                    aria-label={`Use ${host.host} for git push and fetch`}
                    checked={host.gitCredentials}
                    disabled={usable().length === 0 && !host.gitCredentials}
                    onChange={(v) => void setGitCredentials(host, v)}
                  />
                </div>
              </div>
            );
          }}
        </For>
      </div>

      <Show when={hosts().length > 0 && idle()}>
        <div class={cards.more}>
          <Button variant="ghost" onClick={() => openDraft("github", "https://github.com")}>
            Connect another host...
          </Button>
        </div>
      </Show>

      <Show when={!prompt() && draft()}>
        {(d) => (
          <>
            <div class={styles.row}>
              <label class={styles.label}>Provider</label>
              <div class={styles.control}>
                <Select
                  aria-label="Provider"
                  value={d().provider}
                  options={PROVIDERS.map(({ value, label }) => ({ value, label }))}
                  onChange={(value) => {
                    const p = PROVIDERS.find((x) => x.value === value);
                    if (p) openDraft(p.value, p.url);
                  }}
                />
              </div>
            </div>
            <div class={styles.row}>
              <label class={styles.label}>Host URL</label>
              <div class={styles.control}>
                <input
                  type="text"
                  class={`${styles.input} ${styles.text}`}
                  aria-label="Host URL"
                  value={d().url}
                  onInput={(e) => {
                    setRoutes(null);
                    setDraft({ ...d(), url: e.currentTarget.value });
                  }}
                />
                <Show when={!routes()}>
                  <Button variant="primary" onClick={() => void loadRoutes(d())}>
                    Continue
                  </Button>
                </Show>
                <Button variant="ghost" onClick={closeDraft}>
                  Cancel
                </Button>
              </div>
            </div>
            <Show when={routes()}>
              {(r) => (
                <>
                  {/* GitLab registers applications per instance, so this is the
                      one thing that can turn the browser flow on for a host
                      Sway has never seen. */}
                  <Show when={d().provider === "gitlab"}>
                    <div class={styles.row}>
                      <label class={styles.label}>Application ID</label>
                      <div class={styles.control}>
                        <input
                          type="text"
                          class={`${styles.input} ${styles.text}`}
                          aria-label="Application ID"
                          value={appId()}
                          onInput={(e) => setAppId(e.currentTarget.value)}
                        />
                        <Button onClick={() => void saveAppId(d(), r())}>Save</Button>
                      </div>
                      <div class={styles.hint} data-testid="app-id-hint">
                        Optional. An OAuth application on {r().host} with the api scope, registered
                        as public, adds browser sign-in. Without one, paste a token below.
                      </div>
                    </div>
                  </Show>
                  <Show when={r().deviceFlow}>
                    <div class={styles.row}>
                      <label class={styles.label}>Browser</label>
                      <div class={styles.control}>
                        <Button
                          variant="primary"
                          onClick={() => void signInWithBrowser(d().provider, r().baseUrl, d().accountId)}
                        >
                          Sign in with browser
                        </Button>
                      </div>
                    </div>
                  </Show>
                  <div class={styles.row}>
                    <label class={styles.label}>Token</label>
                    <div class={styles.control}>
                      <input
                        type="password"
                        class={`${styles.input} ${styles.text}`}
                        aria-label="Token"
                        value={token()}
                        onInput={(e) => setToken(e.currentTarget.value)}
                      />
                      <Button disabled={busy() || !token().trim()} onClick={() => void addToken()}>
                        Add account
                      </Button>
                    </div>
                    <div class={styles.hint} data-testid="token-scopes">
                      Needs the {r().scopes.join(", ")} scope{r().scopes.length === 1 ? "" : "s"}.{" "}
                      <a href={r().tokenUrl} onClick={(e) => openLink(e, r().tokenUrl)}>
                        Create one on {r().host}
                      </a>
                      .
                    </div>
                  </div>
                </>
              )}
            </Show>
          </>
        )}
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
              <a href={p().verificationUri} onClick={(e) => openLink(e, p().verificationUri)}>
                {p().verificationUri}
              </a>
              . Waiting for you to finish.
            </div>
          </>
        )}
      </Show>

      <Show when={error()}>
        <div class={styles.note} data-testid="forge-error">
          {error()}
        </div>
      </Show>

      {/* The one actual setting here, and it depends on the accounts above.
          Without one it stays on screen and inert rather than disappearing:
          hidden, "where did that setting go?" has no answer, and the row is
          also the only place that says what adding an account is *for*. */}
      <div class={cards.global} classList={{ [styles.inert]: !connected() }}>
        <div class={styles.row}>
          {/* Chrome rather than a form label, the same way `ToggleRow`'s is: the
              grid makes it a sibling of the control, and the shared `Switch`
              generates its own input id, so there is nothing to point `for` at.
              The control names itself instead. */}
          <label class={styles.label}>Show pull requests and checks</label>
          <div class={styles.control}>
            <Switch
              aria-label="Show pull requests and checks"
              checked={settings.forge.enabled}
              disabled={!connected()}
              onChange={(v) => void setEnabled(v)}
            />
          </div>
          <Show when={!connected()}>
            <div class={styles.hint}>Available once a host is connected.</div>
          </Show>
        </div>
      </div>

      <Show when={confirmReq()}>
        {(req) => (
          <ConfirmDialog
            title={req().title}
            message={req().message}
            confirmLabel={req().confirmLabel}
            danger={req().danger}
            onConfirm={() => answerConfirm(true)}
            onCancel={() => answerConfirm(false)}
          />
        )}
      </Show>
    </section>
  );
}

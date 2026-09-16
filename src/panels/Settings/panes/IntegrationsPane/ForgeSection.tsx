import { createSignal, createUniqueId, For, onCleanup, Show, type JSX } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { ArrowDown, ArrowUp, Check, CircleAlert, CornerDownLeft } from "lucide-solid";
import Button from "../../../../components/Button/Button";
import Icon from "../../../../components/Icon/Icon";
import RadioGroup from "../../../../components/RadioGroup/RadioGroup";
import Select from "../../../../components/Select/Select";
import Switch from "../../../../components/Switch/Switch";
import ConfirmDialog, { type ConfirmOpts, type ConfirmReq } from "../../../../components/Dialogs/ConfirmDialog";
import { copyText } from "../../../../utils/clipboard";
import { settings, saveSettings } from "../../settingsStore";
import {
  forgeAccountName,
  forgeErrorMessage,
  isForgeError,
  type AuthState,
  type ForgeAccount,
  type ForgeHost,
  type ForgeProvider,
  type SignInRoutes,
} from "../../../../utils/forgeTypes";
import { noteForgeAccounts, resetForgeResolutions } from "../../../../utils/forgeStatus";
import {
  begin,
  choose,
  CLOUDS,
  failed,
  hostKnown,
  otherRoute,
  SELF_HOSTED,
  startAgain,
  type AddFlow,
  type Cloud,
  type Failure,
  type Product,
  type Route,
  type Target,
} from "./forgeAddFlow";
import styles from "../../Settings.module.css";
import cards from "./ForgeSection.module.css";

// A rejected account is **suspect**, not signed out: its token is still stored,
// so its action is "sign in again", and rendering it as signed out would imply
// Tori discarded a credential it deliberately kept.

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

const STATUS_WORD: Record<AuthState["kind"], string> = {
  signedIn: "signed in",
  suspect: "rejected",
  signedOut: "signed out",
};

const PICKER: { product: Product; name: string; mono: boolean; note: (route: Route) => string }[] = [
  {
    product: "github.com",
    name: "github.com",
    mono: true,
    note: (route) => (route === "browser" ? "No fields. Opens your browser." : "Paste a token."),
  },
  {
    product: "gitlab.com",
    name: "gitlab.com",
    mono: true,
    note: (route) => (route === "browser" ? "No fields. Opens your browser." : "Paste a token."),
  },
  { product: "enterprise", name: "GitHub Enterprise", mono: false, note: () => "Your own server. Host URL, then token." },
  { product: "self-managed", name: "GitLab, self-managed", mono: false, note: () => "Your own instance." },
];

function familyOf(provider: ForgeProvider, host: string): string {
  if (provider === "gitlab") return "GitLab";
  return host === "github.com" ? "GitHub" : "Enterprise";
}

// Every account on a host shares its provider, so the first one names the family.
const family = (host: ForgeHost) => familyOf(host.accounts[0]?.provider ?? "github", host.host);

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

// Day and month apart: newer ICU spells en-GB September "Sept", en-US keeps "Sep".
function rejection(host: string, rejectedAt: number | null): string {
  const at = rejectedAt === null ? null : new Date(rejectedAt * 1000);
  const on = at ? ` on ${at.getDate()} ${at.toLocaleDateString("en-US", { month: "short" })}` : "";
  return `${host} stopped accepting this token${on}. It is still stored, so signing in again replaces it in place.`;
}

const signedIn = (host: ForgeHost) => host.accounts.filter((a) => a.auth.kind === "signedIn");

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

function asFailure(e: unknown): Failure {
  return isForgeError(e)
    ? { kind: "error", message: e.message, code: e.kind }
    : { kind: "error", message: String(e), code: null };
}

function failureText(host: string, failure: Failure, lifetimeSecs: number | null): JSX.Element {
  const minutes = Math.round((lifetimeSecs ?? 0) / 60);
  switch (failure.kind) {
    case "denied":
      return (
        <>
          {host} says the sign-in was denied: <code>{failure.code}</code>. Nothing was stored, and starting
          again issues a fresh code.
        </>
      );
    case "expired":
      return (
        <>
          {host} expired the code before it was entered: <code>{failure.code}</code>.
          {minutes > 0 ? ` Codes last about ${minutes} minute${minutes === 1 ? "" : "s"}.` : ""} Starting again
          issues a fresh one.
        </>
      );
    case "error":
      return (
        <>
          {failure.message}
          {failure.code === null ? "" : <> <code>{failure.code}</code></>}
        </>
      );
  }
}

export default function ForgeSection() {
  const [hosts, setHosts] = createSignal<ForgeHost[]>([]);
  const [flow, setFlow] = createSignal<AddFlow | null>(null);
  const [product, setProduct] = createSignal<Product>("github.com");
  const [cloudRoutes, setCloudRoutes] = createSignal<Partial<Record<Cloud, SignInRoutes>>>({});
  const [routes, setRoutes] = createSignal<SignInRoutes | null>(null);
  const [url, setUrl] = createSignal("");
  const [urlError, setUrlError] = createSignal<string | null>(null);
  const [appIdLater, setAppIdLater] = createSignal(false);
  const [token, setToken] = createSignal("");
  const [prompt, setPrompt] = createSignal<DevicePrompt | null>(null);
  const [lifetimeSecs, setLifetimeSecs] = createSignal<number | null>(null);
  const [deadline, setDeadline] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  const [clipboardOk, setClipboardOk] = createSignal(true);
  const [appIdHost, setAppIdHost] = createSignal<string | null>(null);
  const [appId, setAppId] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [confirmReq, setConfirmReq] = createSignal<ConfirmReq | null>(null);
  const askConfirm = (opts: ConfirmOpts) =>
    new Promise<boolean>((resolve) => setConfirmReq({ ...opts, resolve }));
  const answerConfirm = (ok: boolean) => {
    const req = confirmReq();
    setConfirmReq(null);
    req?.resolve(ok);
  };
  const urlId = createUniqueId();
  const tokenId = createUniqueId();
  let flowEl: HTMLDivElement | undefined;

  // The poll timer is the one piece of state that must not outlive the panel: a
  // device flow left running would keep hitting the host after the user closed
  // Settings, and on a `slow_down` that is exactly how a throttle becomes a
  // block.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  const stopTimers = () => {
    clearTimeout(timer);
    clearInterval(ticker);
    timer = undefined;
    ticker = undefined;
  };
  const endDeviceFlow = () => {
    stopTimers();
    if (!prompt()) return;
    setPrompt(null);
    void invoke("forge_device_cancel");
  };
  onCleanup(endDeviceFlow);

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

  const routesFor = (provider: ForgeProvider, baseUrl: string) =>
    invoke<SignInRoutes>("forge_sign_in_routes", { provider, baseUrl });

  const tokenStep = () => {
    const f = flow();
    return f?.step === "token" ? f : null;
  };
  const waitingStep = () => {
    const f = flow();
    return f?.step === "waiting" ? f : null;
  };
  const errorStep = () => {
    const f = flow();
    return f?.step === "error" ? f : null;
  };
  const urlStep = () => {
    const f = flow();
    return f?.step === "host-url" ? f : null;
  };

  async function enter(next: AddFlow | null) {
    endDeviceFlow();
    setError(null);
    setFlow(next);
    // Keyboard focus follows the card, so Escape lands on it and not on the panel.
    queueMicrotask(() => (flowEl?.querySelector<HTMLElement>("input:not([type=radio]), input:checked") ?? flowEl)?.focus());
    switch (next?.step) {
      case "product": {
        const load = (cloud: Cloud) => routesFor(CLOUDS[cloud].provider, CLOUDS[cloud].baseUrl).catch(() => undefined);
        const [github, gitlab] = await Promise.all([load("github.com"), load("gitlab.com")]);
        setCloudRoutes({ "github.com": github, "gitlab.com": gitlab });
        return;
      }
      case "host-url":
        setUrl("");
        setUrlError(null);
        setAppIdLater(false);
        return;
      case "token":
        setToken("");
        setRoutes(await routesFor(next.target.provider, next.target.baseUrl).catch(() => null));
        return;
      case "waiting":
        return startBrowser(next);
    }
  }

  async function connect(target: Target) {
    try {
      const r = await routesFor(target.provider, target.baseUrl);
      void enter(begin({ ...target, baseUrl: r.baseUrl }, r.deviceFlow));
    } catch (e) {
      setError(forgeErrorMessage(e));
    }
  }

  const connectHost = (host: ForgeHost, accountId: string | null = null) => {
    const first = host.accounts.find((a) => a.id === accountId) ?? host.accounts[0];
    if (first) void connect({ provider: first.provider, baseUrl: first.baseUrl, accountId });
  };

  const routeOf = (p: Product): Route =>
    p !== "enterprise" && p !== "self-managed" && cloudRoutes()[p]?.deviceFlow ? "browser" : "token";

  const continuePicker = () => void enter(choose(product(), routeOf(product()) === "browser"));

  // Built once: fresh option objects would remount the radios, and with them
  // the focus, when the routes arrive.
  const pickerOptions = PICKER.map((p) => ({
    value: p.product,
    label: (
      <span class={cards.tileHead}>
        <span class={cards.tileName} data-mono={p.mono ? "" : undefined}>
          {p.name}
        </span>
        <span class={cards.route} data-route={routeOf(p.product)}>
          {routeOf(p.product)}
        </span>
      </span>
    ),
    description: <>{p.note(routeOf(p.product))}</>,
  }));

  async function submitUrl() {
    const state = urlStep();
    if (!state) return;
    setUrlError(null);
    try {
      const r = await routesFor(SELF_HOSTED[state.product], url());
      void enter(hostKnown(state.product, r.baseUrl));
    } catch (e) {
      setUrlError(forgeErrorMessage(e));
    }
  }

  async function submitToken() {
    const state = tokenStep();
    if (!state) return;
    setBusy(true);
    try {
      await invoke("forge_add_token", {
        provider: state.target.provider,
        baseUrl: state.target.baseUrl,
        token: token(),
        accountId: state.target.accountId,
      });
      await enter(null);
      await refresh();
    } catch (e) {
      void enter(failed(state, asFailure(e)));
    } finally {
      setBusy(false);
    }
  }

  async function startBrowser(state: Extract<AddFlow, { step: "waiting" }>) {
    const { provider, baseUrl, accountId } = state.target;
    try {
      const p = await invoke<DevicePrompt>("forge_device_start", { provider, baseUrl, accountId });
      if (flow() !== state) return void invoke("forge_device_cancel");
      setPrompt(p);
      setLifetimeSecs(p.expiresInSecs);
      setDeadline(Date.now() + p.expiresInSecs * 1000);
      setNow(Date.now());
      // On the clipboard before the page opens, so the paste is ready when it loads.
      setClipboardOk(await copyText(p.userCode));
      if (flow() !== state || prompt() !== p) return;
      window.open(p.verificationUri, "_blank");
      schedule(p.intervalSecs);
      ticker = setInterval(tick, 1000);
    } catch (e) {
      if (flow() === state) void enter(failed(state, asFailure(e)));
    }
  }

  // At zero the host is asked rather than told: its own `expired_token` is what
  // the error card quotes, and a clock that runs ahead of the host's is not.
  function tick() {
    setNow(Date.now());
    if (Date.now() < deadline()) return;
    stopTimers();
    void pollOnce();
  }

  // The interval comes from the server on every turn, so a `slow_down` actually
  // slows this caller down instead of being noted and ignored.
  function schedule(seconds: number) {
    clearTimeout(timer);
    timer = setTimeout(() => void pollOnce(), seconds * 1000);
  }

  async function pollOnce() {
    const state = waitingStep();
    if (!state) return;
    let report: PollReport;
    try {
      report = await invoke<PollReport>("forge_device_poll");
    } catch (e) {
      if (flow() === state) void enter(failed(state, asFailure(e)));
      return;
    }
    if (flow() !== state) return;
    switch (report.kind) {
      case "authorized":
        setPrompt(null);
        await enter(null);
        await refresh();
        return;
      case "pending":
        schedule(report.nextIntervalSecs);
        return;
      case "denied":
      case "expired":
        setPrompt(null);
        void enter(failed(state, { kind: report.kind, code: report.code }));
        return;
    }
  }

  async function copyAgain() {
    const p = prompt();
    if (p) setClipboardOk(await copyText(p.userCode));
  }

  const onFlowKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // `Settings.tsx` closes the whole panel on an Escape that reaches it.
    e.stopPropagation();
    e.preventDefault();
    void enter(null);
  };

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

  async function toggleAppId(host: ForgeHost) {
    const first = host.accounts[0];
    if (!first) return;
    if (appIdHost() === host.host) return setAppIdHost(null);
    try {
      setAppId((await routesFor(first.provider, first.baseUrl)).appId ?? "");
      setAppIdHost(host.host);
    } catch (e) {
      setError(forgeErrorMessage(e));
    }
  }

  async function saveAppId(host: ForgeHost) {
    const first = host.accounts[0];
    if (!first) return;
    setError(null);
    try {
      await invoke("forge_set_app_id", { provider: first.provider, baseUrl: first.baseUrl, appId: appId() });
      setAppIdHost(null);
    } catch (e) {
      setError(forgeErrorMessage(e));
    }
  }

  async function remove(host: string, account: ForgeAccount) {
    const ok = await askConfirm({
      title: `Remove ${forgeAccountName(account)} from ${host}?`,
      message: "Tori deletes the token it stored for this account.",
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

  const openLink = (e: MouseEvent, url: string) => {
    e.preventDefault();
    window.open(url, "_blank");
  };

  const connected = () => hosts().length > 0;
  const connectGithub = () => void connect({ ...CLOUDS["github.com"], accountId: null });
  const openPicker = () => {
    setProduct("github.com");
    void enter({ step: "product" });
  };

  const setEnabled = (enabled: boolean) =>
    saveSettings({ ...settings, forge: { ...settings.forge, enabled } });

  return (
    <section class={styles.section}>
      <div class={styles.sectionTitle}>
        <span>Hosts</span>
        <span class={styles.sectionRule} />
      </div>

      <div class={cards.stack}>
        <Show when={hosts().length === 0 && !flow()}>
          <div class={cards.empty}>
            <div class={cards.emptyTitle}>No hosts connected</div>
            <div class={cards.emptyBody}>
              Connect a host and its pull requests, merge requests and checks show up beside the branch
              they belong to.
            </div>
            <div class={cards.emptyActions}>
              <Button variant="primary" onClick={connectGithub}>
                Connect github.com
              </Button>
              <Button variant="ghost" onClick={openPicker}>
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
                  <Show when={family(host) === "GitLab" && host.host !== "gitlab.com"}>
                    <Button
                      variant="ghost"
                      size="xs"
                      aria-expanded={appIdHost() === host.host}
                      onClick={() => void toggleAppId(host)}
                    >
                      Application ID
                    </Button>
                  </Show>
                  <Button
                    variant="ghost"
                    size="xs"
                    aria-label={`Add account on ${host.host}`}
                    onClick={() => connectHost(host)}
                  >
                    Add account
                  </Button>
                </div>
                <Show when={appIdHost() === host.host}>
                  <div class={cards.appId}>
                    <div class={cards.fieldRow}>
                      <input
                        type="text"
                        class={`${styles.input} ${styles.text}`}
                        aria-label={`Application ID for ${host.host}`}
                        value={appId()}
                        onInput={(e) => setAppId(e.currentTarget.value)}
                      />
                      <Button variant="primary" size="xs" onClick={() => void saveAppId(host)}>
                        Save
                      </Button>
                    </div>
                    <div class={cards.hint}>
                      A public OAuth application on {host.host} with the api scope, and "Device authorization
                      grant" ticked if the form has it. Once one is saved, adding an account here opens the browser.
                    </div>
                  </div>
                </Show>
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
                          <Button variant="primary" size="xs" onClick={() => connectHost(host, account.id)}>
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

        <Show when={flow()}>
          <div
            ref={flowEl}
            class={cards.flow}
            tabindex="-1"
            data-testid="add-flow"
            onKeyDown={onFlowKeyDown}
          >
            <Show when={flow()?.step === "product"}>
              <div class={cards.card}>
                <div class={cards.body}>
                  <div class={cards.flowHead}>
                    <span class={cards.flowTitle}>Connect a host</span>
                    <span class={cards.rule} />
                    <span class={cards.keys} aria-hidden="true">
                      <Icon icon={ArrowUp} size={12} />
                      <Icon icon={ArrowDown} size={12} />
                      <Icon icon={CornerDownLeft} size={12} />
                    </span>
                  </div>
                  <div
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      continuePicker();
                    }}
                  >
                    <RadioGroup
                      itemClass={cards.tile}
                      aria-label="Host to connect"
                      orientation="horizontal"
                      value={product()}
                      onChange={(v) => setProduct(PICKER.find((p) => p.product === v)?.product ?? product())}
                      options={pickerOptions}
                    />
                  </div>
                  <div class={cards.actions}>
                    <Button variant="ghost" onClick={() => void enter(null)}>
                      Cancel
                    </Button>
                    <Button variant="primary" onClick={continuePicker}>
                      Continue
                    </Button>
                  </div>
                </div>
              </div>
            </Show>

            <Show when={urlStep()}>
              {(state) => (
                <div class={cards.card}>
                  <div class={cards.head}>
                    <span class={cards.flowTitle}>
                      {state().product === "enterprise" ? "GitHub Enterprise" : "GitLab, self-managed"}
                    </span>
                    <span class={cards.spacer} />
                    <span class={cards.meta}>step 1 of 2</span>
                  </div>
                  <div class={cards.body}>
                    <label class={cards.fieldLabel} for={urlId}>
                      Host URL
                    </label>
                    <div class={cards.fieldRow}>
                      <input
                        id={urlId}
                        type="text"
                        class={`${styles.input} ${styles.text}`}
                        placeholder={
                          state().product === "enterprise" ? "https://github.example.com" : "https://gitlab.example.com"
                        }
                        value={url()}
                        onInput={(e) => setUrl(e.currentTarget.value)}
                        onKeyDown={(e) => e.key === "Enter" && void submitUrl()}
                      />
                      <Button variant="primary" disabled={!url().trim()} onClick={() => void submitUrl()}>
                        Continue
                      </Button>
                      <Button variant="ghost" onClick={() => void enter(null)}>
                        Cancel
                      </Button>
                    </div>
                    <div class={cards.hint} data-testid="host-url-hint">
                      {urlError() ?? "https only. Next step is a token."}
                    </div>
                  </div>
                  <Show when={state().product === "self-managed" && !appIdLater()}>
                    <div class={cards.footer}>
                      <span class={cards.footNote}>
                        Browser sign-in for this instance needs its OAuth Application ID, from a public app with
                        the api scope and "Device authorization grant" ticked if the form has it. Optional: once one
                        is saved on the host card, adding an account there opens the browser.
                      </span>
                      <Button variant="ghost" size="xs" onClick={() => setAppIdLater(true)}>
                        Add later
                      </Button>
                    </div>
                  </Show>
                </div>
              )}
            </Show>

            <Show when={tokenStep()}>
              {(state) => (
                <div class={cards.card}>
                  <div class={cards.head}>
                    <span class={cards.host}>{hostOf(state().target.baseUrl)}</span>
                    <span
                      class={cards.tag}
                      data-family={familyOf(state().target.provider, hostOf(state().target.baseUrl))}
                    >
                      {familyOf(state().target.provider, hostOf(state().target.baseUrl))}
                    </span>
                    <span class={cards.spacer} />
                    <span class={cards.meta}>{state().target.accountId ? "sign in again" : "new account"}</span>
                  </div>
                  <div class={cards.body}>
                    <label class={cards.fieldLabel} for={tokenId}>
                      Personal access token
                    </label>
                    <div class={cards.fieldRow}>
                      <input
                        id={tokenId}
                        type="password"
                        class={`${styles.input} ${styles.text}`}
                        value={token()}
                        onInput={(e) => setToken(e.currentTarget.value)}
                        onKeyDown={(e) => e.key === "Enter" && token().trim() && void submitToken()}
                      />
                      <Button
                        variant="primary"
                        disabled={busy() || !token().trim()}
                        onClick={() => void submitToken()}
                      >
                        Sign in
                      </Button>
                      <Button variant="ghost" onClick={() => void enter(null)}>
                        Cancel
                      </Button>
                    </div>
                    <Show when={routes()}>
                      {(r) => (
                        <>
                          <div class={cards.scopes} data-testid="token-scopes">
                            <span>Scopes</span>
                            <For each={r().scopes}>{(scope) => <span class={cards.chip}>{scope}</span>}</For>
                            <Show when={r().scopes.length > 1}>
                              <span>The second only if you push over {r().host}.</span>
                            </Show>
                          </div>
                          <div class={cards.hint}>
                            <a href={r().tokenUrl} onClick={(e) => openLink(e, r().tokenUrl)}>
                              Create a token on {r().host}
                            </a>
                          </div>
                        </>
                      )}
                    </Show>
                  </div>
                </div>
              )}
            </Show>

            <Show when={waitingStep()}>
              {(state) => (
                <div class={cards.card} data-tone="brand">
                  <div class={cards.band} data-tone="brand">
                    <span class={cards.pulse} aria-hidden="true" />
                    <span class={cards.bandTitle}>Waiting for {hostOf(state().target.baseUrl)}</span>
                    <span class={cards.spacer} />
                    <Show when={prompt()}>
                      <span class={cards.meta} data-testid="expires">
                        expires in {mmss(deadline() - now())}
                      </span>
                    </Show>
                  </div>
                  <div class={cards.wait}>
                    <Show
                      when={prompt()}
                      fallback={<div class={cards.lead}>Asking {hostOf(state().target.baseUrl)} for a code...</div>}
                    >
                      {(p) => (
                        <>
                          <div class={cards.lead}>The page is open in your browser. Paste this, then come back.</div>
                          <div class={cards.code} data-testid="device-code">
                            <span>{codeGroups(p().userCode)[0]}</span>
                            <span class={cards.codeBar} aria-hidden="true" />
                            <span>{codeGroups(p().userCode)[1]}</span>
                          </div>
                          <Show
                            when={clipboardOk()}
                            fallback={
                              <div class={cards.copied}>
                                <Button variant="primary" size="xs" onClick={() => void copyAgain()}>
                                  Copy the code
                                </Button>
                              </div>
                            }
                          >
                            <div class={cards.copied} data-testid="clipboard-confirmation">
                              <span class={cards.check} aria-hidden="true">
                                <Icon icon={Check} size={10} strokeWidth={2.5} />
                              </span>
                              <span class={cards.copiedWord}>Already on your clipboard</span>
                              <span>, Cmd+V is all you need</span>
                            </div>
                          </Show>
                        </>
                      )}
                    </Show>
                  </div>
                  <div class={cards.footer}>
                    <span class={cards.footNote}>
                      Closed the page, or the clipboard is blocked?{" "}
                      <Show when={prompt()}>
                        {(p) => (
                          <>
                            <a href={p().verificationUri} onClick={(e) => openLink(e, p().verificationUri)}>
                              Reopen {p().verificationUri.replace(/^https?:\/\//, "")}
                            </a>{" "}
                            <button type="button" class={cards.link} onClick={() => void copyAgain()}>
                              Copy again
                            </button>
                          </>
                        )}
                      </Show>
                    </span>
                    <Button variant="ghost" size="xs" onClick={() => void enter(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </Show>

            <Show when={errorStep()}>
              {(state) => (
                <div class={cards.card} data-tone="danger">
                  <div class={cards.band} data-tone="danger">
                    <span class={cards.dot} data-auth="suspect" aria-hidden="true" />
                    <span class={cards.bandTitle}>Sign-in failed</span>
                    <span class={cards.spacer} />
                    <span class={cards.meta}>
                      {hostOf(state().target.baseUrl)} via {state().route}
                    </span>
                  </div>
                  <div class={cards.body}>
                    <div class={cards.failure}>
                      <Icon icon={CircleAlert} size={15} class={cards.failureIcon} aria-hidden="true" />
                      <div class={cards.failureText} data-testid="flow-error">
                        {failureText(hostOf(state().target.baseUrl), state().failure, lifetimeSecs())}
                      </div>
                    </div>
                    <div class={cards.actions} data-align="start">
                      <Button variant="primary" onClick={() => void enter(startAgain(state()))}>
                        Start again
                      </Button>
                      <Show when={state().route === "browser"}>
                        <Button variant="ghost" onClick={() => void enter(otherRoute(state(), false))}>
                          Paste a token instead
                        </Button>
                      </Show>
                      <Show when={state().route === "token" && routes()?.deviceFlow}>
                        <Button variant="ghost" onClick={() => void enter(otherRoute(state(), true))}>
                          Sign in with browser instead
                        </Button>
                      </Show>
                      <Button variant="ghost" class={cards.quiet} onClick={() => void enter(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </Show>
          </div>
        </Show>
      </div>

      <Show when={hosts().length > 0 && !flow()}>
        <div class={cards.more}>
          <Button variant="ghost" onClick={openPicker}>
            Connect another host...
          </Button>
        </div>
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

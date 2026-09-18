import { createSignal, createUniqueId, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { ArrowDown, ArrowUp, CircleAlert, CornerDownLeft, Plus } from "lucide-solid";
import Button from "../../../../components/Button/Button";
import Icon from "../../../../components/Icon/Icon";
import IconButton from "../../../../components/IconButton/IconButton";
import { GitHubLogo, GitLabLogo } from "../../../../components/Icon/gitMarks";
import RadioGroup from "../../../../components/RadioGroup/RadioGroup";
import Select from "../../../../components/Select/Select";
import Switch from "../../../../components/Switch/Switch";
import ConfirmDialog, { type ConfirmOpts, type ConfirmReq } from "../../../../components/Dialogs/ConfirmDialog";
import { settings, saveSettings } from "../../settingsStore";
import {
  forgeAccountName,
  forgeErrorMessage,
  type AuthState,
  type ForgeAccount,
  type ForgeHost,
  type ForgeProvider,
  type SignInRoutes,
  type SignInStart,
} from "../../../../utils/forgeTypes";
import {
  forgeAccountOrgNotices,
  noteForgeAccounts,
  resetForgeResolutions,
} from "../../../../utils/forgeStatus";
import {
  began,
  CLOUDS,
  failed,
  granted,
  isSelfHosted,
  pasteInstead,
  SELF_HOSTED,
  type AddFlow,
  type Product,
  type Target,
} from "./forgeAddFlow";
import { asFailure, createDeviceFlow, failureText, openInBrowser } from "./deviceFlow";
import DeviceWaitCard from "./DeviceWaitCard";
import styles from "../../Settings.module.css";
import cards from "./ForgeSection.module.css";

// A rejected account is **suspect**, not signed out: its token is still stored,
// so its action is "sign in again", and rendering it as signed out would imply
// Tori discarded a credential it deliberately kept.

const STATUS_WORD: Record<AuthState["kind"], string> = {
  signedIn: "signed in",
  suspect: "rejected",
  signedOut: "signed out",
};

const PICKER: { product: Product; name: string; mono: boolean; note: string }[] = [
  { product: "github.com", name: "github.com", mono: true, note: "Uses your GitHub CLI login when you have one." },
  { product: "gitlab.com", name: "gitlab.com", mono: true, note: "No fields. Opens your browser." },
  { product: "enterprise", name: "GitHub Enterprise", mono: false, note: "Your own server. Host URL first." },
  { product: "self-managed", name: "GitLab, self-managed", mono: false, note: "Your own instance." },
];

/// Where a row's credential came from. Worth a word on the row because it
/// decides what repairing the account involves: a `gh` account is repaired by
/// `gh`, and a pasted one by pasting again.
const SOURCE_WORD: Record<ForgeAccount["source"], string> = {
  cli: "GitHub CLI",
  browser: "browser",
  token: "token",
};

function familyOf(provider: ForgeProvider, host: string): string {
  if (provider === "gitlab") return "GitLab";
  return host === "github.com" ? "GitHub" : "Enterprise";
}

// A classic token that reports scopes and lacks `workflow` is refused on any push
// touching `.github/workflows/`. An empty list is a fine-grained token, whose
// permissions Tori cannot read, so it gets no nudge.
function needsWorkflow(account: ForgeAccount): boolean {
  const scopes = account.scopes ?? [];
  return account.provider === "github" && scopes.length > 0 && !scopes.includes("workflow");
}

// `gh`'s own minimum is repo, read:org and gist, so a login made before it asked
// for `workflow` has to widen the grant rather than make a new credential.
// Signing in again would only re-read the same narrow token.
const widenWorkflow = (account: ForgeAccount) =>
  account.source === "cli"
    ? "Pushes that change GitHub Actions need a wider grant: run gh auth refresh -s workflow."
    : "Pushes that change GitHub Actions need a newer sign-in.";

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
function dayMonth(secs: number): string {
  const at = new Date(secs * 1000);
  return `${at.getDate()} ${at.toLocaleDateString("en-US", { month: "short" })}`;
}

// With the year, for a date that is not within days of today: a deadline three
// months out and one three months past read identically without it.
const fullDate = (secs: number) => `${dayMonth(secs)} ${new Date(secs * 1000).getFullYear()}`;

function rejection(host: string, rejectedAt: number | null): string {
  const on = rejectedAt === null ? "" : ` on ${dayMonth(rejectedAt)}`;
  return `${host} stopped accepting this token${on}. It is still stored, so signing in again replaces it in place.`;
}

// Long enough that making a new token is something to schedule rather than an
// interruption, short enough that the row is not permanently warning.
const EXPIRY_WARNING_SECS = 7 * 24 * 60 * 60;

/// Where a dated token stands, carrying the date it stands on so nothing
/// downstream has to reach back for it. `null` covers both a token with days
/// left and one set to never expire, the two states with nothing to say.
type Expiry = { state: "soon" | "lapsed"; at: number } | null;

function expiryOf(account: ForgeAccount, now = Date.now() / 1000): Expiry {
  const at = account.expiresAt;
  if (at === null) return null;
  if (at <= now) return { state: "lapsed", at };
  return at - now <= EXPIRY_WARNING_SECS ? { state: "soon", at } : null;
}

const expiryText = ({ state, at }: NonNullable<Expiry>) =>
  `This token ${state === "lapsed" ? "expired" : "expires"} on ${fullDate(at)}. ` +
  "Signing in again replaces it in place.";

/// Which of the scopes the token step asked for the host did not hand over. A
/// token reporting none is fine-grained, whose permissions Tori cannot read, so
/// it is never told it is short of anything.
function missingScopes(account: ForgeAccount, asked: string[]): string[] {
  const held = account.scopes ?? [];
  return held.length === 0 ? [] : asked.filter((scope) => !held.includes(scope));
}

// Authorizing is a decision GitHub takes from the user on its own page, so the
// row can only carry them to it.
const blockedBy = (count: number) =>
  `${count === 1 ? "An organisation has" : "Organisations have"} not let this account through:`;

const signedIn = (host: ForgeHost) => host.accounts.filter((a) => a.auth.kind === "signedIn");

export default function ForgeSection() {
  const [hosts, setHosts] = createSignal<ForgeHost[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [flow, setFlow] = createSignal<AddFlow | null>(null);
  const [product, setProduct] = createSignal<Product>("github.com");
  const [routes, setRoutes] = createSignal<SignInRoutes | null>(null);
  const [url, setUrl] = createSignal("");
  const [urlError, setUrlError] = createSignal<string | null>(null);
  const [appIdLater, setAppIdLater] = createSignal(false);
  const [token, setToken] = createSignal("");
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

  // Accounts change here and nowhere else, so this is the one place that knows
  // the moment they do. Telling the poll store directly is what makes the chips
  // appear on sign-in and vanish on removal, not at the next focus.
  const refresh = async () => {
    const list = await invoke<ForgeHost[]>("forge_accounts").catch(() => null);
    setLoaded(true);
    if (!Array.isArray(list)) return;
    setHosts(list);
    noteForgeAccounts(list.flatMap((h) => h.accounts));
  };
  void refresh();

  const device = createDeviceFlow({
    onAuthorized: async () => {
      enter(null);
      await refresh();
    },
    onFailed: (failure) => {
      const state = flow();
      if (state) enter(failed(state, failure));
    },
  });

  const tokenStep = () => {
    const f = flow();
    return f?.step === "token" ? f : null;
  };
  const grantedStep = () => {
    const f = flow();
    return f?.step === "granted" ? f : null;
  };
  // Read back from the account list rather than from the paste, so the card
  // shows what Rust actually recorded for it.
  const grantedAccount = () => {
    const id = grantedStep()?.accountId;
    return id ? (hosts().flatMap((h) => h.accounts).find((a) => a.id === id) ?? null) : null;
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

  function enter(next: AddFlow | null) {
    device.cancel();
    setError(null);
    setFlow(next);
    // Keyboard focus follows the card, so Escape lands on it and not on the panel.
    queueMicrotask(() => (flowEl?.querySelector<HTMLElement>("input:not([type=radio]), input:checked") ?? flowEl)?.focus());
    switch (next?.step) {
      case "host-url":
        setUrl("");
        setUrlError(null);
        setAppIdLater(false);
        return;
      case "token":
      case "granted":
        setToken("");
    }
  }

  /// Rust picks the route, so this asks for the sign-in rather than for a menu.
  async function connect(target: Target, onError?: (message: string) => void, preferCli = false) {
    // Before Rust is asked, never after: starting a flow and then cancelling
    // would drop the pending sign-in that was just created.
    device.cancel();
    try {
      const start = await invoke<SignInStart>("forge_sign_in_start", {
        provider: target.provider,
        baseUrl: target.baseUrl,
        accountId: target.accountId,
        // Rust keeps `gh` away from an account the user pasted a token for,
        // because that would hijack a re-auth they meant to type. Pressing a
        // control that names the CLI is the one thing that says otherwise.
        preferCli,
      });
      if (start.kind !== "signedIn") setRoutes(start.routes);
      enter(began({ ...target, baseUrl: start.kind === "signedIn" ? target.baseUrl : start.routes.baseUrl }, start));
      if (start.kind === "browser") return void device.resume(start.prompt);
      if (start.kind === "signedIn") await refresh();
    } catch (e) {
      if (onError) return onError(forgeErrorMessage(e));
      const state = flow();
      if (state?.step === "token" || state?.step === "waiting") return enter(failed(state, asFailure(e)));
      setError(forgeErrorMessage(e));
    }
  }

  const connectHost = (host: ForgeHost, accountId: string | null = null, preferCli = false) => {
    const first = host.accounts.find((a) => a.id === accountId) ?? host.accounts[0];
    if (first)
      void connect({ provider: first.provider, baseUrl: first.baseUrl, accountId }, undefined, preferCli);
  };

  const continuePicker = () => {
    const p = product();
    if (isSelfHosted(p)) return enter({ step: "host-url", product: p });
    void connect({ ...CLOUDS[p], accountId: null });
  };

  // Built once: fresh option objects would remount the radios, and with them the
  // focus, on any re-render.
  const pickerOptions = PICKER.map((p) => ({
    value: p.product,
    label: (
      <span class={cards.tileHead}>
        <span class={cards.tileName} data-mono={p.mono ? "" : undefined}>
          {p.name}
        </span>
      </span>
    ),
    description: <>{p.note}</>,
  }));

  function submitUrl() {
    const state = urlStep();
    if (!state) return;
    setUrlError(null);
    void connect({ provider: SELF_HOSTED[state.product], baseUrl: url(), accountId: null }, setUrlError);
  }

  async function submitToken() {
    const state = tokenStep();
    if (!state) return;
    setBusy(true);
    try {
      const signed = await invoke<{ accountId: string }>("forge_add_token", {
        provider: state.target.provider,
        baseUrl: state.target.baseUrl,
        token: token(),
        accountId: state.target.accountId,
      });
      // Before the step moves on, so the card reads the account the host just
      // described rather than the one this list held a moment ago. A list that
      // did not come back has nothing to render, so the flow closes as it did
      // before there was a card.
      await refresh();
      const known = hosts().some((h) => h.accounts.some((a) => a.id === signed.accountId));
      enter(known ? granted(state, signed.accountId) : null);
    } catch (e) {
      enter(failed(state, asFailure(e)));
    } finally {
      setBusy(false);
    }
  }

  const onFlowKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // `Settings.tsx` closes the whole panel on an Escape that reaches it.
    e.stopPropagation();
    e.preventDefault();
    enter(null);
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

  async function setGitEverywhere(host: ForgeHost, enabled: boolean) {
    setError(null);
    try {
      const list = await invoke<ForgeHost[]>("forge_set_git_everywhere", { host: host.host, enabled });
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

  function toggleAppId(host: ForgeHost) {
    if (!host.accounts[0]) return;
    if (appIdHost() === host.host) return setAppIdHost(null);
    setAppId(host.appId ?? "");
    setAppIdHost(host.host);
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
    openInBrowser(url);
  };

  const connected = () => hosts().length > 0;
  const connectGithub = () => void connect({ ...CLOUDS["github.com"], accountId: null });
  const openPicker = () => {
    setProduct("github.com");
    enter({ step: "product" });
  };

  const setEnabled = (enabled: boolean) =>
    saveSettings({ ...settings, forge: { ...settings.forge, enabled } });

  return (
    <section class={styles.section}>
      <div class={styles.sectionTitle}>
        <span>Hosts</span>
        <span class={styles.sectionRule} />
        <IconButton
          size="sm"
          icon={<Icon icon={Plus} />}
          tooltip="Connect a host"
          onClick={openPicker}
          disabled={!!flow()}
        />
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
                  <span class={cards.logo} aria-hidden="true">
                    <Show when={family(host) === "GitLab"} fallback={<GitHubLogo size="calc(16px * var(--ui-scale))" />}>
                      <GitLabLogo size="calc(16px * var(--ui-scale))" />
                    </Show>
                  </span>
                  <span class={cards.host}>{host.host}</span>
                  <span class={cards.tag} data-family={family(host)}>
                    {family(host)}
                  </span>
                  <span class={cards.spacer} />
                  <Show when={family(host) === "GitLab" && host.host !== "gitlab.com"}>
                    <Button
                      variant="ghost"
                      aria-expanded={appIdHost() === host.host}
                      onClick={() => toggleAppId(host)}
                    >
                      Application ID
                    </Button>
                  </Show>
                  <Button
                    variant="ghost"
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
                  {(account) => {
                    const expiry = () => expiryOf(account);
                    const nudged = () =>
                      account.auth.kind === "signedIn" && (needsWorkflow(account) || expiry() !== null);
                    return (
                      <div
                        class={cards.account}
                        classList={{
                          [cards.rejected]: account.auth.kind === "suspect" || expiry()?.state === "lapsed",
                          [cards.nudged]: nudged(),
                        }}
                        data-testid="forge-account"
                      >
                        <div class={cards.line}>
                          <span class={cards.dot} data-auth={account.auth.kind} aria-hidden="true" />
                          <span class={cards.login}>{forgeAccountName(account)}</span>
                          <span class={cards.word} data-auth={account.auth.kind}>
                            {STATUS_WORD[account.auth.kind]}
                          </span>
                          <span class={cards.source} data-testid="account-source">
                            via {SOURCE_WORD[account.source]}
                          </span>
                          {/* A `cli` account nudged only about scopes gets no
                              button: signing in again re-reads the same `gh`
                              token, so only widening the grant in `gh` helps. */}
                          <Show
                            when={
                              account.auth.kind !== "signedIn" ||
                              expiry() !== null ||
                              (needsWorkflow(account) && account.source !== "cli")
                            }
                          >
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
                        <Show when={account.auth.kind === "signedIn" && needsWorkflow(account)}>
                          <div class={`${cards.reason} ${cards.nudge}`} data-testid="workflow-notice">
                            {widenWorkflow(account)}
                          </div>
                        </Show>
                        {/* An organisation that never approved Tori says so
                            nowhere: only a repo that would not open reveals it,
                            so the row offers the route this account has not
                            spent. */}
                        <For each={forgeAccountOrgNotices(account.id)}>
                          {(notice) => (
                            <div class={cards.orgs} data-testid="org-unapproved-notice">
                              <span>{notice.message}</span>
                              <Button
                                variant="ghost"
                                size="xs"
                                onClick={() => connectHost(host, account.id, notice.route === "cli")}
                              >
                                {notice.action}
                              </Button>
                            </div>
                          )}
                        </For>
                        <Show when={account.orgAccess.length > 0}>
                          <div class={cards.orgs} data-testid="org-access-notice">
                            <span>{blockedBy(account.orgAccess.length)}</span>
                            <For each={account.orgAccess}>
                              {(org) => (
                                <Button variant="ghost" size="xs" onClick={() => openInBrowser(org.url)}>
                                  Authorize for {org.org}
                                </Button>
                              )}
                            </For>
                          </div>
                        </Show>
                        {/* A lapsed token is Tori's own read of a date, not a
                            refusal the host made, so it keeps the row's colour
                            and drops the quiet nudge tone. */}
                        <Show when={account.auth.kind === "signedIn" && expiry()}>
                          {(due) => (
                            <div
                              class={cards.reason}
                              classList={{ [cards.nudge]: due().state === "soon" }}
                              data-testid="expiry-notice"
                            >
                              {expiryText(due())}
                            </div>
                          )}
                        </Show>
                      </div>
                    );
                  }}
                </For>
                <div class={cards.footer} classList={{ [cards.footerInert]: usable().length === 0 }}>
                  <div class={cards.footerText}>
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
                    <div class={cards.footerNote}>
                      Covers Tori's own git, terminal tabs and agents. Tabs and agents already open need reopening
                      after you turn it on.
                    </div>
                  </div>
                  <Switch
                    aria-label={`Use ${host.host} for git push and fetch`}
                    checked={host.gitCredentials}
                    disabled={usable().length === 0 && !host.gitCredentials}
                    onChange={(v) => void setGitCredentials(host, v)}
                  />
                </div>
                <div class={cards.footer} classList={{ [cards.footerInert]: !host.gitCredentials }}>
                  <div class={cards.footerText}>
                    <div class={cards.footerLabel}>
                      <span>Use for git everywhere</span>
                    </div>
                    <div class={cards.footerNote}>
                      Your own terminal and editor too, through one include in your global git config. Tori has to be
                      running: while it's closed, git on {host.host} asks you.
                    </div>
                  </div>
                  <Switch
                    aria-label={`Use ${host.host} for git everywhere`}
                    checked={host.gitEverywhere}
                    disabled={!host.gitCredentials}
                    onChange={(v) => void setGitEverywhere(host, v)}
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
                    <Button variant="ghost" onClick={() => enter(null)}>
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
                      <Button variant="ghost" onClick={() => enter(null)}>
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
                      <Button variant="ghost" onClick={() => enter(null)}>
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
                              <span>
                                {state().target.provider === "github"
                                  ? "The second only if you push changes to GitHub Actions."
                                  : `The second only if you push over ${r().host}.`}
                              </span>
                            </Show>
                          </div>
                          <div class={cards.hint}>
                            <a class={cards.link} href={r().tokenUrl} onClick={(e) => openLink(e, r().tokenUrl)}>
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

            <Show when={grantedAccount()}>
              {(account) => (
                <div class={cards.card} data-tone="brand">
                  <div class={cards.band} data-tone="brand">
                    <span class={cards.dot} data-auth="signedIn" aria-hidden="true" />
                    <span class={cards.bandTitle}>Signed in</span>
                    <span class={cards.spacer} />
                    <span class={cards.meta}>{forgeAccountName(account())}</span>
                  </div>
                  <div class={cards.body}>
                    <Show when={routes()}>
                      {(r) => (
                        <>
                          <div class={cards.scopes} data-testid="granted-scopes">
                            <span>Granted</span>
                            <For each={account().scopes ?? []}>
                              {(scope) => <span class={cards.chip}>{scope}</span>}
                            </For>
                            {/* Only GitHub mints a token whose permissions it
                                will not report. Anywhere else an empty list is
                                a host that did not answer, not a token that
                                holds nothing. */}
                            <Show when={(account().scopes ?? []).length === 0}>
                              <span>
                                {account().provider === "github"
                                  ? "Nothing Tori can read, which is what a fine-grained token reports."
                                  : `${r().host} did not report this token's scopes, so Tori cannot check them.`}
                              </span>
                            </Show>
                          </div>
                          <Show when={missingScopes(account(), r().scopes).length > 0}>
                            <div class={cards.hint} data-testid="missing-scopes">
                              {r().host} did not grant {missingScopes(account(), r().scopes).join(", ")}. Make a
                              token with them ticked and paste it here to replace this one.
                            </div>
                          </Show>
                        </>
                      )}
                    </Show>
                    <div class={cards.hint} data-testid="granted-expiry">
                      <Show
                        when={account().expiresAt}
                        fallback="No expiration, so Tori will not ask for this token again."
                      >
                        {(at) => (
                          <>
                            Expires on {fullDate(at())}, and this row says so a week before. A token set to "No
                            expiration" never asks again.
                          </>
                        )}
                      </Show>
                    </div>
                    <div class={cards.actions}>
                      <Button variant="primary" onClick={() => enter(null)}>
                        Done
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </Show>

            <Show when={waitingStep()}>
              {(state) => (
                <DeviceWaitCard
                  host={hostOf(state().target.baseUrl)}
                  prompt={device.prompt()}
                  remainingMs={device.remainingMs()}
                  clipboardOk={device.clipboardOk()}
                  onCopyAgain={() => void device.copyAgain()}
                  onCancel={() => enter(null)}
                />
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
                        {failureText(hostOf(state().target.baseUrl), state().failure, device.lifetimeSecs())}
                      </div>
                    </div>
                    <div class={cards.actions} data-align="start">
                      <Button variant="primary" onClick={() => void connect(state().target)}>
                        Start again
                      </Button>
                      <Show when={state().route === "browser"}>
                        <Button variant="ghost" onClick={() => enter(pasteInstead(state()))}>
                          Paste a token instead
                        </Button>
                      </Show>
                      <Button variant="ghost" class={cards.quiet} onClick={() => enter(null)}>
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
              checked={settings.forge.enabled && (connected() || !loaded())}
              disabled={loaded() && !connected()}
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

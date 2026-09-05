import { For, Show, createResource, createSignal } from "solid-js";
import { Plus, RefreshCw } from "lucide-solid";
import { invoke } from "@tauri-apps/api/core";
import Button from "../../../../components/Button/Button";
import Icon from "../../../../components/Icon/Icon";
import IconButton from "../../../../components/IconButton/IconButton";
import ConfirmDialog, { type ConfirmReq } from "../../../../components/Dialogs/ConfirmDialog";
import PromptModal from "../../../../components/Dialogs/PromptModal";
import { homeDir } from "@tauri-apps/api/path";
import { OPEN_JOB, TOAST, emitWith, type OpenJob, type ToastEvent } from "../../../../utils/events";
import { asTabProfile, refreshAgentHealth, type SignIn } from "../../../../utils/agentHealth";
import { defaultProfile, setDefaultProfile } from "../../../../utils/agentEnabled";
import { catalogFor, forgetModelCatalogs } from "../../../../utils/modelCatalog";
import { forgetProfileEnvs } from "../../../../utils/profileEnv";
import { loginJob, loginNote, type LoginRoute } from "../../../../utils/signIn";
import styles from "../../Settings.module.css";

// The accounts half of an agent card: who is signed in, and the one control
// that changes it.
//
// Three things this deliberately does not do.
//
// It never reads a credential. On macOS there is nothing to read: Phase 0
// measured that `claude` keeps its tokens in the login Keychain, keyed by config
// dir, so a profile home holds no secret at all. Everything on this screen came
// out of the agent's own `whoami` probe.
//
// It never completes a login itself. `claude auth login` is browser OAuth with
// no non-interactive variant, so the button opens a real terminal tab and gets
// out of the way.
//
// It never offers "add account" for an adapter that has not been measured
// holding two logins at once. `canAdd` is the backend's `supports_isolation`,
// which is earned rather than inferred from merely having a home variable: an
// adapter that shares one credential store behind that variable would accept a
// second account and silently sign the first one out.

/** Mirrors `crate::accounts::ProfileStatus`. */
export type ProfileStatus = {
  id: string;
  label: string;
  isDefault: boolean;
  home: string | null;
  signIn: SignIn;
  // Per profile, never per adapter: the route carries the home variable, so one
  // route shared across a card would send every "Sign in" press to whichever
  // account the shared copy happened to name.
  login: LoginRoute;
  account: string | null;
  apiKeySource: string | null;
  duplicateOf: string | null;
};

/** Mirrors `crate::accounts::RemovalOutcome`. */
type RemovalOutcome = { type: "removed" } | { type: "needsConfirming"; message: string };

/** Mirrors `crate::accounts::AccountsView`. */
export type AccountsView = {
  adapterId: string;
  declared: boolean;
  canAdd: boolean;
  canSignOut: boolean;
  profiles: ProfileStatus[];
};

const SIGN_IN_LABEL: Record<SignIn, string> = {
  signedIn: "Signed in",
  signedOut: "Not signed in",
  // Not a failure and not a warning: plenty of agents have no way to say.
  unknown: "Sign-in state unknown",
};

function toast(message: string, kind: ToastEvent["kind"]) {
  emitWith<ToastEvent>(TOAST, { message, kind });
}

function ProfileRow(props: {
  agentId: string;
  agentLabel: string;
  view: AccountsView;
  profile: ProfileStatus;
  cwd: string;
  /** Whether this card is choosing between accounts at all. False on a
   *  single-account install, where "which one do new sessions start on" is a
   *  question about one thing - the rule `namedProfiles` keeps everywhere
   *  else, asked here of the list this card already has. */
  chooseDefault: boolean;
  onChanged: () => void;
  /** In-app confirmation. `window.confirm` is a silent no-op in Tauri's macOS
   *  webview, which would turn "ask before removing an account that cannot be
   *  signed out" into "never remove it". */
  confirm: (title: string, message: string) => Promise<boolean>;
}) {
  const p = () => props.profile;
  const [busy, setBusy] = createSignal(false);

  /** What this account answered when it was last asked what it can run: the
   *  plan in the agent's own words and how many models came back. Empty until
   *  it has been asked, which renders as nothing rather than as a zero. */
  const catalogue = () => catalogFor(props.agentId, asTabProfile(p().id))?.catalogue ?? null;
  const models = () => catalogue()?.models.length ?? 0;
  const fact = () =>
    [
      catalogue()?.account?.subscriptionType.trim(),
      models() ? `${models()} model${models() === 1 ? "" : "s"}` : "",
    ]
      .filter(Boolean)
      .join(", ");

  const signIn = () => {
    const job = loginJob(
      props.agentId,
      props.agentLabel,
      p().id,
      p().label,
      p().login,
      props.cwd,
    );
    if (!job) {
      toast(loginNote(props.agentLabel, p().login) ?? "", "info");
      return;
    }
    emitWith<OpenJob>(OPEN_JOB, job);
  };

  // Two calls rather than one command with a flag, so the sentence the user
  // agrees to is the backend's own refusal text rather than something this
  // component wrote from memory. The first call is what produces it.
  const call = (confirmedWithoutLogout: boolean) =>
    invoke<RemovalOutcome>("remove_agent_account", {
      adapterId: props.agentId,
      profileId: p().id,
      confirmedWithoutLogout,
    });

  // Recoverable, so no confirmation step: the agent's own logout revokes the
  // credential and the profile stays, ready to be signed back in to. Removal
  // below is the destructive sibling and keeps its dialog.
  const signOut = async () => {
    setBusy(true);
    try {
      await invoke("sign_out_agent_account", {
        adapterId: props.agentId,
        profileId: p().id,
      });
      toast(`Signed ${p().label} out.`, "info");
      props.onChanged();
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      const first = await call(false);
      // "Needs confirming" arrives as a value rather than an error, so this
      // never has to tell it apart from a refusal by reading the message. The
      // other refusals are final - a session in flight, a logout the agent
      // rejected - and offering "remove anyway?" for those would be offering
      // something the backend will refuse again.
      if (first.type === "removed") {
        toast(`Removed ${p().label}.`, "info");
        props.onChanged();
        return;
      }
      if (!(await props.confirm(`Remove ${p().label}?`, first.message))) return;
      await call(true);
      toast(`Removed ${p().label}. Its tokens stay valid until they expire.`, "info");
      props.onChanged();
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class={styles.accountRow}>
      <div class={styles.accountMain}>
        {/* Green only for the agent's own "yes": unknown is dim, because most
            agents have no way to answer and dim must not read as broken. */}
        <span class={`${styles.dot} ${p().signIn === "signedIn" ? styles.dotOk : styles.dotOff}`} />
        <span class={styles.accountName}>{p().label}</span>
        <Show when={p().isDefault}>
          <span class={styles.accountAside}>(your existing login)</span>
        </Show>
        {/* Which account new sessions start on, where there is more than one to
            start on. A radio rather than a switch per row, because the accounts
            are alternatives: two switches on would be a state nothing can act
            on. Named after the account it picks, so a reader hears which row
            they are on rather than "Default" three times. */}
        <Show when={props.chooseDefault}>
          <label class={styles.accountDefault}>
            <input
              type="radio"
              name={`default-account-${props.agentId}`}
              aria-label={`Default account: ${p().label}`}
              checked={defaultProfile(props.agentId) === p().id}
              onChange={() => setDefaultProfile(props.agentId, p().id)}
            />
            Default
          </label>
        </Show>
        {/* The account the agent named where it named one; its sign-in state
            where it did not. One fact, never both: the email already implies
            signed in. */}
        <span class={styles.accountFact}>{p().account ?? SIGN_IN_LABEL[p().signIn]}</span>
        {/* And what that account can run, from its own catalogue: the plan it
            named and how many models it offered. Two accounts of one binary can
            be on different plans, so this is the row that says which is which. */}
        <Show when={fact()}>
          <span class={styles.accountAside}>{fact()}</span>
        </Show>
        <Show when={p().signIn !== "signedIn"}>
          <Button size="sm" onClick={signIn}>
            Sign in
          </Button>
        </Show>
        {/* Only where the adapter declares a logout command: `canSignOut` is
            the backend saying one exists, and a button without one could only
            pretend. */}
        <Show when={p().signIn === "signedIn" && props.view.canSignOut}>
          <Button size="sm" onClick={() => void signOut()} disabled={busy()}>
            Sign out
          </Button>
        </Show>
        <Show when={!p().isDefault}>
          <Button size="sm" variant="danger" onClick={() => void remove()} disabled={busy()}>
            {props.view.canSignOut ? "Sign out and remove" : "Remove"}
          </Button>
        </Show>
      </div>
      {/* The agent's own answer about which credential it will bill against,
          not Sway reading its environment and guessing which variables matter
          to which agent. A notice, never a block: the session still runs. */}
      <Show when={p().apiKeySource}>
        {(source) => (
          <div class={styles.hint}>
            <code>{source()}</code> is set, so this account bills against that API key rather than
            its subscription. Unset it to go back to the subscription.
          </div>
        )}
      </Show>
      {/* Two profiles on one account is a thing somebody may genuinely want, so
          this says what it sees and leaves the decision alone. */}
      <Show when={p().duplicateOf}>
        {(first) => (
          <div class={styles.hint}>
            Signed in to the same account as {first()}, so the two are indistinguishable except by
            name.
          </div>
        )}
      </Show>
    </div>
  );
}

export default function AgentAccounts(props: {
  agentId: string;
  agentLabel: string;
  /** The page-level health re-probe, run before this list's own refetch so the
   *  verdict pill above and the rows below move together. */
  onRecheck?: () => Promise<unknown>;
}) {
  const [view, { refetch }] = createResource(
    () => props.agentId,
    (id) => invoke<AccountsView>("agent_accounts", { adapterId: id }),
  );
  // A login has no working directory of its own; a terminal needs somewhere to
  // be. Home is the one place that is always there and never surprising, and it
  // keeps this component from having to be told about the user's workspace for
  // a reason that has nothing to do with the workspace.
  const [cwd] = createResource(() => homeDir().catch(() => "/"));
  const [adding, setAdding] = createSignal(false);

  // Both modals are the in-app ones. Tauri's macOS webview implements neither
  // `window.confirm` nor `window.prompt`, so the browser versions would silently
  // do nothing: no name entered, no confirmation given, and no error either.
  const [nameReq, setNameReq] = createSignal<{ resolve: (v: string | null) => void } | null>(null);
  const askName = () => new Promise<string | null>((resolve) => setNameReq({ resolve }));
  const resolveName = (v: string | null) => {
    const req = nameReq();
    setNameReq(null);
    req?.resolve(v);
  };
  const [confirmReq, setConfirmReq] = createSignal<ConfirmReq | null>(null);
  const askConfirm = (title: string, message: string) =>
    new Promise<boolean>((resolve) =>
      setConfirmReq({ title, message, confirmLabel: "Remove", danger: true, resolve }),
    );
  const resolveConfirm = (v: boolean) => {
    const req = confirmReq();
    setConfirmReq(null);
    req?.resolve(v);
  };

  // Re-probe both: this screen's per-profile answers and the cached sweep the
  // picker and the status line above read. Otherwise removing the account a
  // agent was signed in to would leave it offered for new sessions.
  // Refresh before refetch, in that order: this list reads the default
  // profile's answer out of the cached sweep, so refetching first would read
  // the answer that was true before whatever just happened.
  const changed = () => {
    // An account is a transcript root, so adding or removing one changes the
    // set of directories worth watching. Without this the new account's
    // sessions appear only when something else asks for a listing, and the old
    // account's root is watched after its home is gone. The command replaces
    // the watcher rather than adding a second one.
    void invoke("sessions_watch_start").catch(() => {});
    // A tab derives its spawn environment from its profile id and memoizes the
    // answer, so a home that has just been created, renamed away from or
    // deleted has to stop being remembered here.
    forgetProfileEnvs();
    // And a catalogue is an account's answer, so the set of rows the store
    // holds changes with the set of accounts. An added one has no row until
    // this is dropped, and nothing that only asks about rows it can see would
    // ever probe it.
    forgetModelCatalogs();
    void refreshAgentHealth().then(() => refetch());
  };

  // The heading's "Check again": the same refresh order as `changed` (probe,
  // then read), without the watcher restart nothing changed on disk needs.
  const [checking, setChecking] = createSignal(false);
  const recheck = async () => {
    setChecking(true);
    try {
      await (props.onRecheck ? props.onRecheck() : refreshAgentHealth());
      await refetch();
    } finally {
      setChecking(false);
    }
  };

  const add = async () => {
    const label = (await askName())?.trim();
    if (!label) return;
    setAdding(true);
    try {
      // The profile and its home exist before anyone signs in, which is why the
      // route comes back from here: the job it starts has to carry *this*
      // profile's home, or the login lands in the account the user already had.
      const route = await invoke<LoginRoute>("add_agent_account", {
        adapterId: props.agentId,
        label,
      });
      changed();
      const job = loginJob(props.agentId, props.agentLabel, label, label, route, cwd() ?? "/");
      if (job) emitWith<OpenJob>(OPEN_JOB, job);
      else toast(loginNote(props.agentLabel, route) ?? "", "info");
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setAdding(false);
    }
  };

  return (
    // An adapter that declares no `[accounts]` table renders nothing at all,
    // rather than a set of controls that cannot do anything. "Sway has nothing
    // true to say about this agent's accounts" is not the same claim as
    // "nobody is signed in".
    <Show when={view()?.declared && view()}>
      {(v) => (
        <>
          {/* Its own heading rather than the detail page's, so a agent whose
              adapter declares no accounts table gets no empty section. "Check
              again" here re-runs the per-profile whoami probes, which the
              page-level re-check deliberately does not: that one is a cached
              sweep, this list is the screen that pays for fresh answers. */}
          <div class={styles.groupHead}>
            <span class={styles.groupTitle}>Accounts</span>
            <span class={styles.sectionRule} />
            <IconButton
              size="sm"
              icon={<Icon icon={RefreshCw} />}
              tooltip="Check again"
              onClick={() => void recheck()}
              disabled={checking()}
            />
          </div>
          <div class={styles.accountsCard}>
            <For each={v().profiles}>
              {(profile) => (
                <ProfileRow
                  agentId={props.agentId}
                  agentLabel={props.agentLabel}
                  view={v()}
                  profile={profile}
                  cwd={cwd() ?? "/"}
                  chooseDefault={v().profiles.length > 1}
                  onChanged={changed}
                  confirm={askConfirm}
                />
              )}
            </For>
          </div>
          {/* No button at all where adding is off. The old rendering kept a
              disabled button beside a sentence about unmeasured isolation -
              a message for whoever maintains the adapters, which belongs in
              ADAPTERS.md, not in the app. */}
          <Show when={v().canAdd}>
            <div class={styles.cardActions}>
              <Button
                size="sm"
                icon={<Icon icon={Plus} />}
                onClick={() => void add()}
                disabled={adding()}
              >
                Add account
              </Button>
              <span class={styles.actionNote}>
                Each account keeps its own session and model list. Pick one per chat.
              </span>
            </div>
          </Show>
          <Show when={nameReq()}>
            <PromptModal
              title={`Name for the new ${props.agentLabel} account`}
              note="Sway's own label for it. The agent never sees this."
              okLabel="Create and sign in"
              onSubmit={(v) => resolveName(v)}
              onCancel={() => resolveName(null)}
            />
          </Show>
          <Show when={confirmReq()}>
            {(req) => (
              <ConfirmDialog
                title={req().title}
                message={req().message}
                confirmLabel={req().confirmLabel}
                danger={req().danger}
                onConfirm={() => resolveConfirm(true)}
                onCancel={() => resolveConfirm(false)}
              />
            )}
          </Show>
        </>
      )}
    </Show>
  );
}

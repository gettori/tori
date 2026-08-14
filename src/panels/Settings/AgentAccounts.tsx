import { For, Show, createResource, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import Button from "../../components/Button/Button";
import ConfirmDialog, { type ConfirmReq } from "../../components/Dialogs/ConfirmDialog";
import PromptModal from "../../components/Dialogs/PromptModal";
import { homeDir } from "@tauri-apps/api/path";
import { OPEN_TERMINAL, TOAST, emitWith, type OpenTerminal, type ToastEvent } from "../../utils/events";
import { refreshAgentHealth, type SignIn } from "../../utils/agentHealth";
import { loginTab, loginNote, type LoginRoute } from "../../utils/signIn";
import styles from "./Settings.module.css";

// The accounts half of an agent card: who is signed in, and the one control
// that changes it.
//
// Three things this deliberately does not do.
//
// It never reads a credential. On macOS there is nothing to read: Phase 0
// measured that `claude` keeps its tokens in the login Keychain, keyed by config
// dir, so a profile home holds no secret at all. Everything on this screen came
// out of the harness's own `whoami` probe.
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
  signedOut: "Signed out",
  // Not a failure and not a warning: plenty of harnesses have no way to say.
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
  onChanged: () => void;
  /** In-app confirmation. `window.confirm` is a silent no-op in Tauri's macOS
   *  webview, which would turn "ask before removing an account that cannot be
   *  signed out" into "never remove it". */
  confirm: (title: string, message: string) => Promise<boolean>;
}) {
  const p = () => props.profile;
  const [busy, setBusy] = createSignal(false);

  const signIn = () => {
    const tab = loginTab(
      props.agentId,
      props.agentLabel,
      p().id,
      p().label,
      p().login,
      props.cwd,
    );
    if (!tab) {
      toast(loginNote(props.agentLabel, p().login) ?? "", "info");
      return;
    }
    emitWith<OpenTerminal>(OPEN_TERMINAL, tab);
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

  const remove = async () => {
    setBusy(true);
    try {
      const first = await call(false);
      // "Needs confirming" arrives as a value rather than an error, so this
      // never has to tell it apart from a refusal by reading the message. The
      // other refusals are final - a session in flight, a logout the harness
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
    <div class={styles.cardMeta}>
      <strong>{p().label}</strong>
      {p().isDefault ? " (your existing login)" : ""} · {SIGN_IN_LABEL[p().signIn]}
      <Show when={p().account}>{(account) => <> · {account()}</>}</Show>
      {/* The harness's own answer about which credential it will bill against,
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
      <div class={styles.cardActions}>
        <Show when={p().signIn !== "signedIn"}>
          <Button size="sm" onClick={signIn}>
            Sign in
          </Button>
        </Show>
        <Show when={!p().isDefault}>
          <Button size="sm" variant="danger" onClick={() => void remove()} disabled={busy()}>
            {props.view.canSignOut ? "Sign out and remove" : "Remove"}
          </Button>
        </Show>
      </div>
    </div>
  );
}

export default function AgentAccounts(props: { agentId: string; agentLabel: string }) {
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
  // harness was signed in to would leave it offered for new sessions.
  // Refresh before refetch, in that order: this list reads the default
  // profile's answer out of the cached sweep, so refetching first would read
  // the answer that was true before whatever just happened.
  const changed = () => void refreshAgentHealth().then(() => refetch());

  const add = async () => {
    const label = (await askName())?.trim();
    if (!label) return;
    setAdding(true);
    try {
      // The profile and its home exist before anyone signs in, which is why the
      // route comes back from here: the tab it opens has to carry *this*
      // profile's home, or the login lands in the account the user already had.
      const route = await invoke<LoginRoute>("add_agent_account", {
        adapterId: props.agentId,
        label,
      });
      changed();
      const tab = loginTab(props.agentId, props.agentLabel, label, label, route, cwd() ?? "/");
      if (tab) emitWith<OpenTerminal>(OPEN_TERMINAL, tab);
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
    // true to say about this harness's accounts" is not the same claim as
    // "nobody is signed in".
    <Show when={view()?.declared && view()}>
      {(v) => (
        <>
          <div class={styles.sectionTitle}>Accounts</div>
          <For each={v().profiles}>
            {(profile) => (
              <ProfileRow
                agentId={props.agentId}
                agentLabel={props.agentLabel}
                view={v()}
                profile={profile}
                cwd={cwd() ?? "/"}
                onChanged={changed}
                confirm={askConfirm}
              />
            )}
          </For>
          <Show when={v().canAdd}>
            <div class={styles.cardActions}>
              <Button size="sm" onClick={() => void add()} disabled={adding()}>
                Add account
              </Button>
            </div>
          </Show>
          {/* Said rather than left as a missing button, so "why can I not add a
              second account here" has an answer on screen. */}
          <Show when={!v().canAdd}>
            <div class={styles.hint}>
              Nobody has measured {props.agentLabel} holding two accounts at once, so Sway offers
              one. A second would risk sharing the first one's credentials.
            </div>
          </Show>
          <Show when={nameReq()}>
            <PromptModal
              title={`Name for the new ${props.agentLabel} account`}
              note="Sway's own label for it. The harness never sees this."
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

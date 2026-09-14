import { For, Show, createResource, createSignal, onCleanup } from "solid-js";
import { Minus, Plus, RefreshCw } from "lucide-solid";
import { invoke } from "@tauri-apps/api/core";
import Button from "../../../../components/Button/Button";
import Chevron from "../../../../components/Chevron/Chevron";
import Icon from "../../../../components/Icon/Icon";
import IconButton from "../../../../components/IconButton/IconButton";
import ConfirmDialog from "../../../../components/Dialogs/ConfirmDialog";
import Checkbox from "../../../../components/Checkbox/Checkbox";
import AddAccountDialog from "../../../../components/Dialogs/AddAccountDialog";
import Switch from "../../../../components/Switch/Switch";
import Tooltip from "../../../../components/Tooltip/Tooltip";
import { homeDir } from "@tauri-apps/api/path";
import { OPEN_JOB, TOAST, emitWith, type OpenJob, type ToastEvent } from "../../../../utils/events";
import { asProfileId, asTabProfile, refreshAgentHealth, type SignIn } from "../../../../utils/agentHealth";
import { defaultProfile, setDefaultProfile } from "../../../../utils/agentEnabled";
import { warnAtLabel } from "../../../../utils/chatBudget";
import {
  limitTypeChip,
  limitTypeLabel,
  modelWeekLabel,
  quotaBand,
  quotaState,
  resetsAtMs,
  scopedModel,
  type QuotaState,
} from "../../../../utils/chatRateLimit";
import {
  chipFor,
  declaredRungs,
  modelWindowLabel,
  offersModelWindow,
  setUsageNotify,
  setUsageWarnAt,
  setWindowShown,
  showsWindow,
  usageNotify,
  usageUnavailableReason,
  usageWarnAt,
  type WindowChip,
} from "../../../../utils/usageSettings";
import { pollUsage, usageReason } from "../../../../utils/usageProbe";
import { temporalOf, windowsFor, type WindowReading } from "../../../../utils/usageStore";
import {
  catalogFor,
  ensureModelCatalogsLoaded,
  forgetModelCatalogs,
} from "../../../../utils/modelCatalog";
import { forgetProfileEnvs } from "../../../../utils/profileEnv";
import { loginJob, loginNote, type LoginRoute } from "../../../../utils/signIn";
import dialogStyles from "../../../../components/Dialogs/Dialogs.module.css";
import styles from "../../Settings.module.css";

// One card per account: who is signed in, what their quota is at, and every
// control that belongs to that login rather than to the agent.
//
// **The account is the unit, because the quota window is.** A five-hour window
// belongs to a login, not to an adapter and not to a chat: two Claude accounts
// on one machine have two of them, on two plans. That is why the threshold, the
// notification switch and the titlebar chips all live on the card rather than in
// a section above it, and why there is no Usage section any more.
//
// **The chips are the whole usage control.** Which windows an account puts in
// the titlebar is also how deep Sway reads for it: nothing lit is nothing read,
// the two generic windows come free off the rung the adapter offers, and the
// model-scoped weekly one is the single thing that needs the login Keychain.
// Pressing that chip is the opt-in, so the permission is asked at the moment the
// user asks for the thing it buys.
//
// Three things this deliberately does not do.
//
// It never reads a credential itself. On macOS there is nothing here to read:
// Phase 0 measured that `claude` keeps its tokens in the login Keychain, keyed
// by config dir, so a profile home holds no secret at all. Everything on this
// screen came out of the agent's own `whoami` probe or the usage read.
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
  managed: boolean;
  signIn: SignIn;
  // Per profile, never per adapter: the route carries the home variable, so one
  // route shared across a card would send every "Sign in" press to whichever
  // account the shared copy happened to name.
  login: LoginRoute;
  account: string | null;
  apiKeySource: string | null;
  duplicateOf: string | null;
};

/** What the card is asked to confirm. `removable` adds the "remove it too"
 *  checkbox with what removing does under it, and its state comes back in the
 *  answer. */
type ConfirmAsk = {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  removable?: string;
  /** The profile home the answer is about, where there is one to name. */
  home?: string | null;
};
type ConfirmAnswer = { ok: boolean; remove: boolean };
type AccountAsk = { label: string; folder: string };

/** Mirrors `crate::accounts::RemovalOutcome`. */
type RemovalOutcome = { type: "removed" } | { type: "needsConfirming"; message: string };

/** Mirrors `crate::accounts::AddedAccount`. */
type AddedAccount = { id: string; login: LoginRoute | null };

/** Mirrors `crate::accounts::AccountsView`. */
export type AccountsView = {
  adapterId: string;
  declared: boolean;
  canAdd: boolean;
  canSignOut: boolean;
  defaultPresent: boolean;
  defaultHome: string | null;
  profiles: ProfileStatus[];
};

const SIGN_IN_LABEL: Record<SignIn, string> = {
  signedIn: "Signed in",
  signedOut: "Not signed in",
  // Not a failure and not a warning: plenty of agents have no way to say.
  unknown: "Sign-in state unknown",
};

/** The same stops the shared threshold moves in, so a per-account answer and the
 *  global one are the same kind of number. */
const WARN_AT_MIN = 0.5;
const WARN_AT_MAX = 1;
const WARN_AT_STEP = 0.05;

function toast(message: string, kind: ToastEvent["kind"]) {
  emitWith<ToastEvent>(TOAST, { message, kind });
}

function shortHome(path: string, home: string): string {
  return home.length > 1 && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** When the window empties, in the words the reader needs: a countdown while it
 *  is close enough to plan around, the day and time once it is not. */
function resetLine(at: number | null, now: number): string | null {
  if (at === null) return null;
  const left = at - now;
  if (left <= 0) return "reset";
  if (left < 24 * 60 * 60 * 1000) {
    const hours = Math.floor(left / (60 * 60 * 1000));
    const mins = Math.floor((left % (60 * 60 * 1000)) / 60_000);
    return hours > 0 ? `${hours}h ${mins}m left` : `${mins}m left`;
  }
  return new Date(at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/** One window's card: the level now, and when it goes back to zero. */
function WindowCard(props: {
  name: string;
  reading: WindowReading | null;
  warnAt: number;
  now: number;
  /** Off the titlebar: still shown here, because hiding a bar is not the same
   *  as not wanting to know. */
  dim: boolean;
  note: string | null;
}) {
  const state = (): QuotaState | null =>
    props.reading ? quotaState(props.reading, props.warnAt, props.now) : null;
  const band = () => (props.reading ? quotaBand(props.reading, state()!) : "none");
  const pct = () => {
    const u = props.reading?.utilization;
    return typeof u === "number" ? u * 100 : null;
  };
  // One decimal here and whole percent in the titlebar. This is the screen you
  // come to for the number; the strip is the one you glance at.
  const level = () => (state() === "expired" || pct() === null ? null : `${pct()!.toFixed(1)}%`);

  return (
    <div
      class={styles.winCard}
      classList={{ [styles.winDim]: props.dim }}
      data-state={state() ?? "none"}
      data-band={band()}
      data-temporal={props.reading ? temporalOf(props.reading, props.now) : "none"}
    >
      <div class={styles.winHead}>
        <span class={styles.winName}>{props.name}</span>
        <span class={styles.winLevel}>{level() ?? "-"}</span>
      </div>
      <span class={styles.winTrack} aria-hidden="true">
        <Show when={level() !== null}>
          <span class={styles.winFill} style={{ width: `${Math.min(100, pct()!)}%` }} />
        </Show>
      </span>
      <span class={styles.winFoot}>
        {props.note ??
          (props.reading ? resetLine(resetsAtMs(props.reading.resetsAt), props.now) : null) ??
          "not read yet"}
      </span>
    </div>
  );
}

/** What each chip is called, whether it is lit, and whether anything has ever
 *  answered for it. The one place the three chips are enumerated. */
type Chip = {
  id: WindowChip;
  /** Chip width: "5H", "Week", "Fable". */
  label: string;
  /** Box width: "Session / 5h rolling", "Week / Fable only". */
  name: string;
  lit: boolean;
  reading: WindowReading | null;
};

function chipsFor(agentId: string, profile: string | null): Chip[] {
  const readings = windowsFor(agentId, profile);
  const ids: WindowChip[] = offersModelWindow(agentId)
    ? ["five_hour", "seven_day", "model_week"]
    : ["five_hour", "seven_day"];
  // A week the endpoint scoped to something that is not a model. Listed only
  // once one has been read: unlike the model week, whose chip is how you ask for
  // the read in the first place, this one is named by the answer.
  if (readings.some((w) => chipFor(w.kind) === "week_other")) ids.push("week_other");
  return ids.map((id) => {
    // The scoped weekly window first, where a deep read returned more than one
    // window: an account with both a Fable week and an extra-usage pot is one
    // chip, and it is the model week that names it.
    const reading =
      (id === "model_week"
        ? readings.find((w) => scopedModel(w.kind) !== null)
        : readings.find((w) => w.kind === id)) ??
      readings.find((w) => chipFor(w.kind) === id) ??
      null;
    const guess = id === "model_week" ? modelWindowLabel(agentId, profile) : null;
    return {
      id,
      label: reading ? limitTypeChip(reading.kind) : id === "model_week" ? (guess ?? "Model") : limitTypeChip(id),
      name: reading
        ? (limitTypeLabel(reading.kind) ?? reading.kind)
        : id === "model_week"
          ? modelWeekLabel(guess)
          : (limitTypeLabel(id) ?? id),
      lit: showsWindow(agentId, profile, id),
      reading,
    };
  });
}

/** One box per window Sway can name for this account, plus one per chip that
 *  has nothing to show yet. A deep read can return more windows than there are
 *  chips (an extra-usage pot beside the model week), and a box each is how they
 *  stay visible without a chip nobody could act on. */
type Box = {
  key: string;
  name: string;
  reading: WindowReading | null;
  dim: boolean;
  chip: WindowChip;
};

function boxesFor(agentId: string, profile: string | null): Box[] {
  const readings = windowsFor(agentId, profile);
  return chipsFor(agentId, profile).flatMap<Box>((c) => {
    const mine = readings.filter((w) => chipFor(w.kind) === c.id);
    if (mine.length === 0) {
      return [{ key: c.id, name: c.name, reading: null, dim: !c.lit, chip: c.id }];
    }
    return mine.map((w) => ({
      key: w.kind,
      name: limitTypeLabel(w.kind) ?? w.kind,
      reading: w,
      dim: !c.lit,
      chip: c.id,
    }));
  });
}

/** The titlebar preview, and the control for it. */
function WindowChips(props: {
  agentId: string;
  profile: string | null;
  onAsk: (chip: WindowChip, on: boolean) => void;
}) {
  const chips = () => chipsFor(props.agentId, props.profile);
  /** The one chip that cannot answer until it is allowed to. On the other two a
   *  missing reading is a read that has not landed yet, which the window card
   *  below already says; marking those "n/a" too would be noise on every fresh
   *  install. */
  const locked = (c: Chip) => c.id === "model_week" && c.reading === null;
  const why = (c: Chip) =>
    locked(c)
      ? `Sway has to read this account's token from the login Keychain to see its ${c.label} window. macOS asks the first time.`
      : `Show the ${limitTypeLabel(c.reading ? c.reading.kind : c.id)} window in the titlebar`;

  return (
    <div class={styles.chipRow}>
      <For each={chips()}>
        {(c) => (
          <Tooltip
            as="button"
            type="button"
            class={styles.chip}
            classList={{ [styles.chipOn]: c.lit, [styles.chipIdle]: locked(c) }}
            label={why(c)}
            aria-pressed={c.lit}
            onClick={() => props.onAsk(c.id, !c.lit)}
          >
            {c.label}
            <Show when={locked(c)}>
              <span class={styles.chipNa}>n/a</span>
            </Show>
          </Tooltip>
        )}
      </For>
    </div>
  );
}

/** The threshold, in the stops the shared control moves in. Its own value only
 *  once it is moved: until then it shows, and follows, Chat > Warn at. */
function WarnStepper(props: { value: number; label: string; onChange: (v: number) => void }) {
  const step = (by: number) => {
    const next = Math.round((props.value + by) * 100) / 100;
    props.onChange(Math.min(WARN_AT_MAX, Math.max(WARN_AT_MIN, next)));
  };
  return (
    <div class={styles.stepper} role="group" aria-label="Warn at">
      <IconButton
        size="sm"
        icon={<Icon icon={Minus} />}
        aria-label="Warn earlier"
        onClick={() => step(-WARN_AT_STEP)}
        disabled={props.value <= WARN_AT_MIN}
      />
      <span class={styles.stepperValue}>{props.label}</span>
      <IconButton
        size="sm"
        icon={<Icon icon={Plus} />}
        aria-label="Warn later"
        onClick={() => step(WARN_AT_STEP)}
        disabled={props.value >= WARN_AT_MAX}
      />
    </div>
  );
}

function AccountCard(props: {
  agentId: string;
  agentLabel: string;
  view: AccountsView;
  profile: ProfileStatus;
  cwd: string;
  now: number;
  /** Whether this card is choosing between accounts at all. False on a
   *  single-account install, where "which one do new sessions start on" is a
   *  question about one thing - the rule `namedProfiles` keeps everywhere
   *  else, asked here of the list this card already has. */
  chooseDefault: boolean;
  onChanged: () => void;
  /** In-app confirmation. `window.confirm` is a silent no-op in Tauri's macOS
   *  webview, which would turn "ask before removing an account that cannot be
   *  signed out" into "never remove it". */
  confirm: (ask: ConfirmAsk) => Promise<ConfirmAnswer>;
}) {
  const p = () => props.profile;
  const tab = () => asTabProfile(p().id);
  const [busy, setBusy] = createSignal(false);
  // Every account arrives closed and waits to be asked for. The head says who
  // the account is, which is what the list is scanned for; the quota below it
  // is a screen of its own, and an install with three logins was three of them
  // on arrival.
  const [open, setOpen] = createSignal(false);

  /** What this account answered when it was last asked what it can run: the
   *  plan in the agent's own words and how many models came back. Empty until
   *  it has been asked, which renders as nothing rather than as a zero. */
  const catalogue = () => catalogFor(props.agentId, tab())?.catalogue ?? null;
  const models = () => catalogue()?.models.length ?? 0;
  const fact = () =>
    [
      catalogue()?.account?.subscriptionType.trim(),
      models() ? `${models()} model${models() === 1 ? "" : "s"}` : "",
    ]
      .filter(Boolean)
      .join(", ");

  /** Whether this agent has any rung at all. Asked of the ladder rather than of
   *  the reason, because an adapter can decline to explain itself and a card
   *  that showed chips on the strength of a missing sentence would offer
   *  controls for a read that cannot happen. */
  const reads = () => declaredRungs(props.agentId).length > 0;
  const warnAt = () => usageWarnAt(props.agentId, tab());
  const notify = () => usageNotify(props.agentId, tab());

  // The read follows the press. Turning the model window on raises a Keychain
  // prompt, and a prompt that arrives minutes later on a background tick is one
  // nobody connects to what they just did.
  const askWindow = (chip: WindowChip, on: boolean) =>
    void setWindowShown(props.agentId, tab(), chip, on).then(() => {
      if (on) pollUsage(props.agentId, "manual", tab());
    });

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
  const call = (confirmedWithoutLogout: boolean, signOut: boolean) =>
    invoke<RemovalOutcome>("remove_agent_account", {
      adapterId: props.agentId,
      profileId: p().id,
      confirmedWithoutLogout,
      signOut,
    });

  // The default account has no stored home: it is the variable left unset, so
  // the agent resolves the login the user already had and Sway never names it.
  const home = () => {
    const path = p().home;
    return path ? shortHome(path, props.cwd) : null;
  };

  const canSignOut = () => p().signIn === "signedIn" && props.view.canSignOut;
  const canRemove = () => !p().isDefault;
  const removeNote = () =>
    p().managed
      ? "Sway forgets it and deletes the profile home, with the sessions inside."
      : "Sway forgets it. Its folder stays.";

  const signOut = async () => {
    await invoke("sign_out_agent_account", { adapterId: props.agentId, profileId: p().id });
    toast(`Signed ${p().label} out.`, "info");
    props.onChanged();
  };

  const [editing, setEditing] = createSignal(false);
  let abandoned = false;

  const rename = async (value: string) => {
    setEditing(false);
    const label = value.trim();
    if (abandoned || !label || label === p().label) return;
    setBusy(true);
    try {
      await invoke("rename_agent_account", {
        adapterId: props.agentId,
        profileId: p().id,
        label,
      });
      props.onChanged();
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (signOut: boolean) => {
    const first = await call(false, signOut);
    // "Needs confirming" arrives as a value rather than an error, so this never
    // has to tell it apart from a refusal by reading the message.
    if (first.type === "removed") {
      toast(`Removed ${p().label}.`, "info");
      props.onChanged();
      return;
    }
    if (!(await props.confirm({ title: `Remove ${p().label}?`, message: first.message })).ok) return;
    await call(true, signOut);
    toast(`Removed ${p().label}. Its tokens stay valid until they expire.`, "info");
    props.onChanged();
  };

  const act = async () => {
    const answer = await props.confirm(
      canSignOut()
        ? {
            title: `Sign ${p().label} out?`,
            message: `${props.agentLabel} revokes this login. You can sign back in from here.`,
            confirmLabel: "Sign out",
            removable: canRemove() ? removeNote() : undefined,
            home: home(),
          }
        : {
            title: `Remove ${p().label}?`,
            message: p().managed
              ? "Sway forgets this account and deletes the profile home it made for it, with the sessions inside."
              : "Sway forgets this account. Its folder and the login in it stay.",
            confirmLabel: "Remove",
            danger: true,
            home: home(),
          },
    );
    if (!answer.ok) return;
    setBusy(true);
    try {
      if (answer.remove || !canSignOut()) await remove(answer.remove);
      else await signOut();
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class={styles.acctCard}>
      <div class={styles.acctHead}>
        {/* Green only for the agent's own "yes": unknown is dim, because most
            agents have no way to answer and dim must not read as broken. */}
        <span class={`${styles.dot} ${p().signIn === "signedIn" ? styles.dotOk : styles.dotOff}`} />
        <Show
          when={editing()}
          fallback={
            <button
              type="button"
              class={styles.accountName}
              onClick={() => {
                abandoned = false;
                setEditing(true);
              }}
            >
              {p().label}
            </button>
          }
        >
          <input
            class={styles.accountNameEdit}
            aria-label={`Rename ${p().label}`}
            value={p().label}
            ref={(el) => queueMicrotask(() => el.select())}
            onBlur={(e) => void rename(e.currentTarget.value)}
            onKeyDown={(e) => {
              // Escape abandons through the same blur, so the commit above has
              // to know which of the two ways out it is on.
              abandoned = e.key === "Escape";
              if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
            }}
          />
        </Show>
        {/* Which account new sessions start on, where there is more than one to
            start on. A radio rather than a switch per row, because the accounts
            are alternatives: two switches on would be a state nothing can act
            on. Named after the account it picks, so a reader hears which row
            they are on rather than "Default" three times. */}
        <Show when={props.chooseDefault}>
          {/* Lit from the same answer the radio is checked from, not from the
              backend's snapshot of it: picking another account moves the
              setting now and the snapshot only on the next refetch. */}
          <label
            class={styles.defaultPill}
            classList={{ [styles.defaultOn]: defaultProfile(props.agentId) === p().id }}
          >
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

        <div class={styles.acctSummary}>
          {/* Who this account is, and nothing about what Sway does with it. The
              quota settings all had a summary here and it made the head the
              busiest row on the screen; they are one press away, on the card
              that also explains them. */}
          {/* The account the agent named where it named one; its sign-in state
              where it did not. One fact, never both: the email already implies
              signed in. */}
          <span class={styles.accountFact}>{p().account ?? SIGN_IN_LABEL[p().signIn]}</span>
          {/* And what that account can run, from its own catalogue: the plan it
              named and how many models it offered. Two accounts of one binary
              can be on different plans, so this is what says which is which. */}
          <Show when={fact()}>
            <span class={styles.accountAside}>{fact()}</span>
          </Show>
          <Show when={p().signIn !== "signedIn"}>
            <Button size="sm" onClick={signIn}>
              Sign in
            </Button>
          </Show>
          <button
            type="button"
            class={styles.acctToggle}
            aria-expanded={open()}
            aria-label={open() ? `Collapse ${p().label}` : `Expand ${p().label}`}
            onClick={() => setOpen(!open())}
          >
            <Chevron open={open()} />
          </button>
        </div>
      </div>

      <Show when={open()}>
        <div class={styles.acctBody}>
          {/* Where this account lives. On the card rather than as hover text on
              the name, which is where it used to be: a native `title` is
              mouse-only, and the guard in src/test/interactiveTitle.test.ts
              exists to stop exactly that shape. The default account has no path
              to show, because it is the variable left unset. */}
          <div class={styles.acctHome}>{home() ?? "Your existing login"}</div>
          {/* The agent's own answer about which credential it will bill against,
              not Sway reading its environment and guessing which variables
              matter to which agent. A notice, never a block: sessions run. */}
          <Show when={p().apiKeySource}>
            {(source) => (
              <div class={styles.hint}>
                <code>{source()}</code> is set, so this account bills against that API key rather
                than its subscription. Unset it to go back to the subscription.
              </div>
            )}
          </Show>
          {/* Two profiles on one account is a thing somebody may genuinely want,
              so this says what it sees and leaves the decision alone. */}
          <Show when={p().duplicateOf}>
            {(first) => (
              <div class={styles.hint}>
                Signed in to the same account as {first()}, so the two are indistinguishable except
                by name.
              </div>
            )}
          </Show>

          <Show
            when={reads()}
            fallback={
              <div class={styles.hint}>
                Sway reads no quota for {props.agentLabel}
                <Show when={usageUnavailableReason(props.agentId)}>{(why) => <>: {why()}</>}</Show>.
              </div>
            }
          >
            {/* Every window Sway can name for this account, whether or not the
                titlebar carries it: hiding a bar is not the same as not wanting
                to know, and the one that needs permission has to be visible to
                be asked for. */}
            <div class={styles.winRow}>
              <For each={boxesFor(props.agentId, tab())}>
                {(b) => (
                  <WindowCard
                    name={b.name}
                    reading={b.reading}
                    warnAt={warnAt()}
                    now={props.now}
                    dim={b.dim}
                    note={
                      b.chip === "model_week" && b.reading === null
                        ? "needs the account token"
                        : null
                    }
                  />
                )}
              </For>
            </div>

            {/* Beside the windows, never instead of them: a read that failed has
                to say so while whatever a cheaper rung filled stays on screen. */}
            <Show when={usageReason(props.agentId, tab())}>
              {(why) => <div class={styles.hint}>{why()}</div>}
            </Show>

            <div class={styles.acctRow}>
              <span class={styles.label}>Titlebar preview</span>
              <WindowChips agentId={props.agentId} profile={tab()} onAsk={askWindow} />
            </div>

            <div class={styles.acctRow}>
              <span class={styles.label}>Warn at</span>
              <WarnStepper
                value={warnAt()}
                label={warnAtLabel(warnAt())}
                onChange={(v) => void setUsageWarnAt(props.agentId, tab(), v)}
              />
            </div>

            <div class={styles.acctRow}>
              <span class={styles.label}>Notify at the warn point and when spent</span>
              <Switch
                checked={notify()}
                onChange={(on) => void setUsageNotify(props.agentId, tab(), on)}
                aria-label={`Notify about ${p().label} quota`}
              />
            </div>
          </Show>

          {/* Its own box, and the last thing on the card. One control, because
              removing is signing out plus forgetting and the dialog carries that
              as a checkbox; where the adapter declares no logout command this is
              the removal on its own. */}
          <Show when={canSignOut() || canRemove()}>
            <div class={styles.danger}>
              <div>
                <div class={styles.dangerTitle}>Danger area</div>
                <div class={styles.dangerNote}>
                  <Show
                    when={canSignOut()}
                    fallback={
                      p().managed
                        ? `Removing ${p().label} deletes the profile home Sway made for it, with the sessions inside.`
                        : `Removing ${p().label} forgets it here. Its folder and the login in it stay.`
                    }
                  >
                    Signing out drops {p().label}'s token and its group leaves the titlebar. Chats
                    already running on it keep going.
                  </Show>
                </div>
              </div>
              {/* Named after the account it acts on, not after the word on it:
                  two open cards would otherwise offer two buttons called "Sign
                  out" and neither would say whose. */}
              <Button
                aria-label={canSignOut() ? `Sign ${p().label} out` : `Remove ${p().label}`}
                onClick={() => void act()}
                disabled={busy()}
              >
                {canSignOut() ? "Sign out" : "Remove"}
              </Button>
            </div>
          </Show>
        </div>
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
  /** The set of accounts changed. The Files group below resolves its paths
   *  against one home per account, so it is reading a stale set until it is
   *  told - and an added account's rows would otherwise appear only when
   *  somebody reopened the page. */
  onAccountsChanged?: () => void;
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
  // The one transition nothing sends an event for: a window resets on a clock,
  // so without this a card left open would keep counting down past the reset it
  // is counting down to. Same 60s tick the strip runs on, and the same reason.
  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 60_000);
  onCleanup(() => clearInterval(tick));

  // Both modals are the in-app ones. Tauri's macOS webview implements neither
  // `window.confirm` nor `window.prompt`, so the browser versions would silently
  // do nothing: no name entered, no confirmation given, and no error either.
  const [accountReq, setAccountReq] = createSignal<{
    resolve: (v: AccountAsk | null) => void;
  } | null>(null);
  const askAccount = () => new Promise<AccountAsk | null>((resolve) => setAccountReq({ resolve }));
  const resolveAccount = (v: AccountAsk | null) => {
    const req = accountReq();
    setAccountReq(null);
    req?.resolve(v);
  };
  const [confirmReq, setConfirmReq] = createSignal<
    (ConfirmAsk & { resolve: (v: ConfirmAnswer) => void }) | null
  >(null);
  const [alsoRemove, setAlsoRemove] = createSignal(false);
  const askConfirm = (ask: ConfirmAsk) =>
    new Promise<ConfirmAnswer>((resolve) => {
      setAlsoRemove(false);
      setConfirmReq({ ...ask, resolve });
    });
  const resolveConfirm = (ok: boolean) => {
    const req = confirmReq();
    setConfirmReq(null);
    req?.resolve({ ok, remove: ok && alsoRemove() });
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
    // Dropped and read again: the set of rows is per account, so an added or
    // renamed one has no row until the store is refilled, and a Models section
    // reading a store nobody refilled says "unknown" about every account.
    forgetModelCatalogs();
    void ensureModelCatalogsLoaded();
    // Through the page's own re-check where there is one, the way "Check again"
    // goes: the detail page holds its own copy of the sweep, so refreshing only
    // the shared store leaves the Models tabs naming an account that has been
    // renamed or removed until Settings is reopened.
    void (props.onRecheck ? props.onRecheck() : refreshAgentHealth()).then(() => refetch());
    props.onAccountsChanged?.();
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
    const ask = await askAccount();
    const label = ask?.label.trim();
    if (!ask || !label) return;
    setAdding(true);
    try {
      // The profile and its home exist before anyone signs in, which is why the
      // route comes back from here: the job it starts has to carry *this*
      // profile's home, or the login lands in the account the user already had.
      const added = await invoke<AddedAccount>("add_agent_account", {
        adapterId: props.agentId,
        label,
        home: ask.folder.trim() || null,
      });
      // With no login to inherit, nothing in the default picker would be
      // checked and new sessions would start on whichever account lists first.
      if (!view()?.defaultPresent && defaultProfile(props.agentId) === asProfileId(null)) {
        setDefaultProfile(props.agentId, added.id);
      }
      changed();
      if (!added.login) {
        toast(`Added ${label}. It is already signed in.`, "info");
        return;
      }
      const job = loginJob(props.agentId, props.agentLabel, added.id, label, added.login, cwd() ?? "/");
      if (job) emitWith<OpenJob>(OPEN_JOB, job);
      else toast(loginNote(props.agentLabel, added.login) ?? "", "info");
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
            {/* No button at all where adding is off: `canAdd` is the backend
                saying this adapter was measured holding two logins at once. */}
            <Show when={v().canAdd}>
              <IconButton
                size="sm"
                icon={<Icon icon={Plus} />}
                aria-label="Add account"
                tooltip="Add account. Each account keeps its own session and model list. Pick one per chat."
                onClick={() => void add()}
                disabled={adding()}
              />
            </Show>
            <IconButton
              size="sm"
              icon={<Icon icon={RefreshCw} />}
              tooltip="Check again"
              onClick={() => void recheck()}
              disabled={checking()}
            />
          </div>
          <Show when={v().profiles.length > 0}>
            <div class={styles.accountsCard}>
              <For each={v().profiles}>
                {(profile) => (
                  <AccountCard
                    agentId={props.agentId}
                    agentLabel={props.agentLabel}
                    view={v()}
                    profile={profile}
                    cwd={cwd() ?? "/"}
                    now={now()}
                    chooseDefault={v().profiles.length > 1}
                    onChanged={changed}
                    confirm={askConfirm}
                  />
                )}
              </For>
            </div>
          </Show>
          <Show when={v().defaultPresent ? null : v().defaultHome}>
            {(missing) => (
              <div class={styles.hint}>
                No {shortHome(missing(), cwd() ?? "/")} on this machine. Add an account and point it at your{" "}
                {props.agentLabel} folder, or leave the folder empty for one Sway manages.
              </div>
            )}
          </Show>
          <Show when={accountReq()}>
            <AddAccountDialog
              agentLabel={props.agentLabel}
              onSubmit={(v) => resolveAccount(v)}
              onCancel={() => resolveAccount(null)}
            />
          </Show>
          <Show when={confirmReq()}>
            {(req) => (
              <ConfirmDialog
                title={req().title}
                message={req().message}
                confirmLabel={req().confirmLabel}
                danger={req().danger || alsoRemove()}
                extra={
                  <>
                    <Show when={req().home}>
                      {(path) => <div class={dialogStyles.path}>{path()}</div>}
                    </Show>
                    <Show when={req().removable}>
                      {(note) => (
                        <>
                          <Checkbox
                            checked={alsoRemove()}
                            onChange={setAlsoRemove}
                            label="Remove the account as well"
                          />
                          <div class={dialogStyles.optionHint}>{note()}</div>
                        </>
                      )}
                    </Show>
                  </>
                }
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

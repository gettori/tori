// Here and not in Rust: the spend ceiling and the queue hold exist only in the
// webview, and a timer firing through `ChatHost::deliver` would walk past both.
// A restart drops every arm, since restored tabs are inert by design.
import { createStore } from "solid-js/store";

export type Arm = {
  sessionId: string;
  accountKey: string;
  turnId: string;
  /** Epoch **seconds**, as the wire sends it. */
  resetsAt: number;
  /** Armed from the banner's button rather than by the setting. */
  byHand?: boolean;
};

// Settles once the host has taken the turn or the send was refused, which is
// when the account's next continue may go.
export type Fire = () => Promise<void>;

// Firing on the second the window reopens can be refused on clock skew, and the
// refused turn would then report a reset no later than its own end, which
// `arm` ignores: the resume would be lost with nothing on screen.
export const FIRE_GRACE_MS = 45_000;

export const RESUME_TEXT = "Your usage limit has reset. Continue where you left off.";
export const RESUME_ARMED = "Tori will continue this chat when it resets.";
export const RESUME_BUSY = "The usage limit reset while a turn was running, so Tori did not continue this chat.";
export const RESUME_STOPPED =
  "The usage limit reset, but this chat is over its spend ceiling, so Tori did not continue it.";

const [armed, setArmed] = createStore<Record<string, Arm | undefined>>({});
const spent = new Set<string>();
const fires = new Map<string, Fire>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const due = new Map<string, string[]>();
const busy = new Set<string>();

export const armedFor = (sessionId: string): Arm | null => armed[sessionId] ?? null;

// A reset arms once, so the setting cannot re-arm what the user just cancelled.
// The button can: pressing it after a cancel is the user changing their mind.
export function arm(a: Arm): boolean {
  const identity = `${a.sessionId} ${a.turnId} ${a.resetsAt}`;
  if ((spent.has(identity) && !a.byHand) || armed[a.sessionId]) return false;
  spent.add(identity);
  setArmed(a.sessionId, a);
  const delay = Math.max(0, a.resetsAt * 1000 + FIRE_GRACE_MS - Date.now());
  timers.set(
    a.sessionId,
    setTimeout(() => becomeDue(a), delay),
  );
  return true;
}

export function cancel(sessionId: string) {
  clearTimeout(timers.get(sessionId));
  timers.delete(sessionId);
  const a = armed[sessionId];
  if (!a) return;
  setArmed(sessionId, undefined);
  const waiting = due.get(a.accountKey);
  if (waiting)
    due.set(
      a.accountKey,
      waiting.filter((id) => id !== sessionId),
    );
}

// Unregistering cancels: a chat view goes away only when its session does.
export function register(sessionId: string, fire: Fire): () => void {
  fires.set(sessionId, fire);
  return () => {
    if (fires.get(sessionId) === fire) fires.delete(sessionId);
    cancel(sessionId);
  };
}

function becomeDue(a: Arm) {
  timers.delete(a.sessionId);
  due.set(a.accountKey, [...(due.get(a.accountKey) ?? []), a.sessionId]);
  void pump(a.accountKey);
}

// One at a time per account: every chat limited on one login is due in the same
// second, and the first few would spend the fresh window before the rest ran.
async function pump(accountKey: string) {
  if (busy.has(accountKey)) return;
  const next = due.get(accountKey)?.shift();
  if (next === undefined) return;
  busy.add(accountKey);
  const a = armed[next];
  setArmed(next, undefined);
  const fire = fires.get(next);
  try {
    if (a && fire) await fire();
  } catch {
    // A refusal is the fire's to report. Either way the next one goes.
  } finally {
    busy.delete(accountKey);
    void pump(accountKey);
  }
}

export function resetResumeAtResetForTests() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  for (const id of Object.keys(armed)) setArmed(id, undefined);
  spent.clear();
  fires.clear();
  due.clear();
  busy.clear();
}

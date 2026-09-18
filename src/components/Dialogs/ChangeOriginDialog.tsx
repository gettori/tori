import { createSignal, Show } from "solid-js";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";

const CURRENT_LABEL = "origin-current-label";
const URL_LABEL = "origin-url-label";
const URL_HELP = "origin-url-help";

/** What git will take as a remote. Deliberately shallow: the three prefixes are
 *  what a remote is spelled with, and anything past that is git's to reject
 *  with a real message rather than this dialog's to guess at. */
const REMOTE = /^(https:\/\/|git@|ssh:\/\/)\S+$/;

/** The host a remote points at, for echoing the destination back. Null when the
 *  URL has no host to read, which the caller only asks about once it is
 *  well-formed. */
export function originHost(url: string): string | null {
  const scp = /^git@([^:]+):/.exec(url);
  if (scp) return scp[1];
  const scheme = /^[a-z]+:\/\/(?:[^@/]+@)?([^/:]+)/.exec(url);
  return scheme ? scheme[1] : null;
}

/**
 * Point a repo at a different origin, or give one to a repo that has none.
 *
 * **The current URL is a field-shaped row, not a sentence.** It used to be
 * `Current: git@github.com:…` wrapping above the input, so the old value and
 * the new one never lined up and the thing the user is here to compare could
 * not be compared. Same column, same height, same face.
 *
 * **The remote is validated as it is typed**, where anything at all used to be
 * accepted: a typo was taken, written into `.git/config`, and only surfaced on
 * the next fetch. The help line under the field carries all four states, so the
 * group never grows a line mid-keystroke.
 *
 * Remote-tracking refs keep their old state until the next fetch, so pointing at
 * a *different* repo leaves stale `origin/*` branches behind until then. That is
 * git's behaviour and not something this dialog can undo, which is why the help
 * line promises only that branch names survive.
 *
 * The shell is `Dialog`. Enter stays here, through its `onKeyDown`, because the
 * confirm button is `disabled` while the URL is unusable and a disabled button
 * is never clicked. Escape does not: Kobalte reports it as `onClose`.
 */
export default function ChangeOriginDialog(props: {
  projectName: string;
  /** The origin the repo has now, or null when it has none. */
  current: string | null;
  busy: boolean;
  onConfirm: (url: string) => void;
  onCancel: () => void;
}) {
  const [url, setUrl] = createSignal(props.current ?? "");
  let first: HTMLInputElement | undefined;

  const typed = () => url().trim();
  const valid = () => REMOTE.test(typed());
  const same = () => typed() === (props.current ?? "");
  const malformed = () => !!typed() && !valid();
  const canConfirm = () => valid() && !same();

  const help = () => {
    if (!typed()) return "Paste an https or ssh remote.";
    if (!valid()) return "Not a git remote. Expected https://, git@ or ssh://.";
    if (same()) return "Same as the current origin.";
    const host = originHost(typed());
    return host
      ? `Points at ${host}. Existing branches keep their names.`
      : "Existing branches keep their names.";
  };

  const confirm = () => {
    if (props.busy || !canConfirm()) return;
    props.onConfirm(typed());
  };

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    confirm();
  }

  return (
    <Dialog
      open
      size="sheet"
      title={
        props.current
          ? `Change origin for “${props.projectName}”`
          : `Set origin for “${props.projectName}”`
      }
      onClose={() => props.onCancel()}
      onKeyDown={onKeyDown}
      // Selected, not just focused: the field opens holding the current URL, and
      // the usual edit is a replacement rather than an amendment.
      initialFocus={() => {
        first?.select();
        return first;
      }}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button
            variant="primary"
            disabled={props.busy || !canConfirm()}
            onClick={() => confirm()}
          >
            {props.busy ? "Working…" : props.current ? "Change origin" : "Set origin"}
          </Button>
        </>
      }
    >
      <div class={styles.spaceForm}>
        <Show when={props.current}>
          {(now) => (
            <div class={styles.spaceField}>
              <div id={CURRENT_LABEL} class={styles.spaceLabel}>
                Current
              </div>
              {/* Static text, not a disabled field: there is nothing here to
                  operate, and `aria-labelledby` on a role-less element is
                  prohibited, so the line above is read in order instead. */}
              <div class={styles.readonly}>{now()}</div>
            </div>
          )}
        </Show>

        <div class={styles.spaceField}>
          <div class={styles.spaceLabel}>
            <span id={URL_LABEL}>New origin</span>
            <span class={styles.spaceRequired} aria-hidden="true">Required</span>
          </div>
          <input
            ref={first}
            class={`${styles.spaceInput} ${styles.monoInput}`}
            classList={{ [styles.invalid]: malformed() }}
            aria-labelledby={URL_LABEL}
            aria-describedby={URL_HELP}
            aria-required={true}
            aria-invalid={malformed()}
            value={url()}
            placeholder="git@github.com:org/repo.git"
            onInput={(e) => setUrl(e.currentTarget.value)}
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
          />
          <div
            id={URL_HELP}
            class={styles.spaceHelp}
            classList={{ [styles.helpError]: malformed() }}
          >
            {help()}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

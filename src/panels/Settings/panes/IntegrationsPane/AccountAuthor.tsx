import { createSignal, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import Button from "../../../../components/Button/Button";
import { forgeAccountName, forgeErrorMessage, type ForgeAccount } from "../../../../utils/forgeTypes";
import styles from "../../Settings.module.css";
import cards from "./ForgeSection.module.css";

export default function AccountAuthor(props: {
  account: ForgeAccount;
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [editing, setEditing] = createSignal(false);
  const [name, setName] = createSignal("");
  const [email, setEmail] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const confirmed = () => !!props.account.commitName && !!props.account.commitEmail;

  async function open() {
    props.onError(null);
    setName(props.account.commitName ?? "");
    setEmail(props.account.commitEmail ?? "");
    setEditing(true);
    if (confirmed()) return;
    // A host that will not answer leaves the fields empty to type into.
    const hint = await invoke<{ name: string; email: string }>("forge_identity_hint", {
      accountId: props.account.id,
    }).catch(() => null);
    if (hint && editing() && !name() && !email()) {
      setName(hint.name);
      setEmail(hint.email);
    }
  }

  async function save(clear: boolean) {
    setBusy(true);
    props.onError(null);
    try {
      await invoke("forge_set_identity", {
        accountId: props.account.id,
        name: clear ? null : name(),
        email: clear ? null : email(),
      });
      setEditing(false);
      await props.onChanged();
    } catch (e) {
      props.onError(forgeErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Show
      when={editing()}
      fallback={
        <div class={cards.orgs} data-testid="account-author">
          <Show
            when={confirmed()}
            fallback={<span>No commit author. Its repos commit as your global git identity.</span>}
          >
            <span>
              Commits as {props.account.commitName} &lt;{props.account.commitEmail}&gt;
            </span>
          </Show>
          <Button variant="ghost" size="xs" onClick={() => void open()}>
            {confirmed() ? "Edit" : "Set author"}
          </Button>
        </div>
      }
    >
      <div class={cards.appId}>
        <div class={cards.fieldRow}>
          <input
            type="text"
            class={`${styles.input} ${styles.text}`}
            aria-label={`Commit name for ${forgeAccountName(props.account)}`}
            placeholder="Name"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
          />
          <input
            type="email"
            class={`${styles.input} ${styles.text}`}
            aria-label={`Commit email for ${forgeAccountName(props.account)}`}
            placeholder="Email"
            value={email()}
            onInput={(e) => setEmail(e.currentTarget.value)}
          />
          <Button variant="primary" size="xs" disabled={busy()} onClick={() => void save(false)}>
            Save
          </Button>
          <Show when={confirmed()}>
            <Button variant="ghost" size="xs" disabled={busy()} onClick={() => void save(true)}>
              Clear
            </Button>
          </Show>
          <Button variant="ghost" size="xs" disabled={busy()} onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
        <div class={cards.hint}>
          Every repo acting as this account commits as this author, in Tori, terminals and other apps. A repo that
          already sets its own author is left alone until you choose in its Project settings.
        </div>
      </div>
    </Show>
  );
}

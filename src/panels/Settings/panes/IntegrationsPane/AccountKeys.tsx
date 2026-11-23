import { createMemo, createSignal, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import Button from "../../../../components/Button/Button";
import Select from "../../../../components/Select/Select";
import {
  forgeAccountName,
  forgeErrorMessage,
  type ForgeAccount,
  type KeyTest,
  type SshKey,
} from "../../../../utils/forgeTypes";
import cards from "./ForgeSection.module.css";

const NONE = "none";

function testText(test: KeyTest, account: ForgeAccount): string {
  switch (test.kind) {
    case "ok":
      return `Signed in as ${test.login}.`;
    case "mismatch":
      return `This key signs in as ${test.login}, not ${forgeAccountName(account)}.`;
    case "failed":
      return test.message;
  }
}

function caveat(key: SshKey | undefined): string | null {
  if (!key || key.inAgent) return null;
  if (key.file === "none") return "Your ssh agent no longer holds this key.";
  if (key.file === "passphrase") {
    return "This key has a passphrase and is not in your ssh agent. Tori asks for it each time, and agents cannot use it until you add it with ssh-add.";
  }
  return null;
}

export default function AccountKeys(props: {
  account: ForgeAccount;
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const keys = createMemo<SshKey[] | undefined>(
    () =>
      invoke<SshKey[]>("forge_ssh_keys").catch((e) => {
        props.onError(forgeErrorMessage(e));
        return [] as SshKey[];
      }),
    { loadingValue: undefined },
  );
  const [test, setTest] = createSignal<KeyTest | null>(null);
  const [testing, setTesting] = createSignal(false);
  const options = () => [
    { value: NONE, label: "None" },
    ...(keys() ?? []).map((k) => ({ value: k.path, label: k.label })),
  ];
  const keyAt = (path: string | null) => (keys() ?? []).find((k) => k.path === path);

  async function save(sshPublicKey: string | null, signingPublicKey: string | null) {
    props.onError(null);
    setTest(null);
    try {
      await invoke("forge_set_keys", { accountId: props.account.id, sshPublicKey, signingPublicKey });
      await props.onChanged();
    } catch (e) {
      props.onError(forgeErrorMessage(e));
    }
  }

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest(await invoke<KeyTest>("forge_test_ssh_key", { accountId: props.account.id }));
    } catch (e) {
      setTest({ kind: "failed", message: forgeErrorMessage(e) });
    } finally {
      setTesting(false);
    }
  }

  const pick = (value: string) => (value === NONE ? null : value);

  return (
    <>
      <div class={cards.orgs} data-testid="account-ssh-key">
        <span>SSH key</span>
        <Select
          size="xs"
          aria-label={`SSH key for ${forgeAccountName(props.account)}`}
          options={options()}
          value={props.account.sshPublicKey ?? NONE}
          onChange={(value) => void save(pick(value), props.account.signingPublicKey)}
        />
        <Show when={props.account.sshPublicKey}>
          <Button variant="ghost" size="xs" disabled={testing()} onClick={() => void runTest()}>
            Test
          </Button>
        </Show>
        <Show when={test()}>{(t) => <span>{testText(t(), props.account)}</span>}</Show>
      </div>
      <Show when={caveat(keyAt(props.account.sshPublicKey))}>
        {(text) => <div class={`${cards.reason} ${cards.nudge}`}>{text()}</div>}
      </Show>
      <div class={cards.orgs} data-testid="account-signing-key">
        <span>Signing key</span>
        <Select
          size="xs"
          aria-label={`Signing key for ${forgeAccountName(props.account)}`}
          options={options()}
          value={props.account.signingPublicKey ?? NONE}
          onChange={(value) => void save(props.account.sshPublicKey, pick(value))}
        />
      </div>
      <Show when={caveat(keyAt(props.account.signingPublicKey))}>
        {(text) => <div class={`${cards.reason} ${cards.nudge}`}>{text()}</div>}
      </Show>
    </>
  );
}

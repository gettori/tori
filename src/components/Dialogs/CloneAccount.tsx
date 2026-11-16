import { createEffect, createSignal, createUniqueId, on, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import Select from "../Select/Select";
import { forgeAccountName, type ForgeAccount } from "../../utils/forgeTypes";

type CloneAccounts = {
  host: string;
  accounts: ForgeAccount[];
  preselect: string | null;
  overHttps: boolean;
  gitCredentials: boolean;
};

type Access = "yes" | "no" | "unknown";

const SETTLE_MS = 400;

export function createCloneAccount(url: () => string, space: () => string | null) {
  const [choice, setChoice] = createSignal<CloneAccounts | null>(null);
  const [access, setAccess] = createSignal<Record<string, Access> | null>(null);
  const [chosen, setChosen] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);

  createEffect(
    on(
      () => url().trim(),
      (u) => {
        setChoice(null);
        setAccess(null);
        setChosen(null);
        setPending(u !== "");
        if (!u) return;
        let live = true;
        const timer = setTimeout(async () => {
          const found = await invoke<CloneAccounts | null>("forge_clone_accounts", { url: u, space: space() }).catch(
            () => null,
          );
          if (!live) return;
          setChoice(found);
          setPending(false);
          if (!found) return;
          const rows = await invoke<{ accountId: string; access: Access }[]>("forge_repo_access", { url: u }).catch(
            () => [],
          );
          const known = Array.isArray(rows) ? rows : [];
          if (live) setAccess(Object.fromEntries(known.map((r) => [r.accountId, r.access])));
        }, SETTLE_MS);
        onCleanup(() => {
          live = false;
          clearTimeout(timer);
        });
      },
    ),
  );

  const onlyReader = () => {
    const a = access();
    const readers = a ? Object.keys(a).filter((id) => a[id] === "yes") : [];
    return readers.length === 1 ? readers[0] : null;
  };
  const picked = () => chosen() ?? choice()?.preselect ?? onlyReader();

  return {
    choice,
    access,
    picked,
    choose: setChosen,
    ready: () => !pending() && (!choice() || picked() !== null),
    accountId: () => (choice() ? picked() : null),
  };
}

export type CloneAccountPick = ReturnType<typeof createCloneAccount>;

export function CloneAccountField(props: {
  pick: CloneAccountPick;
  fieldClass: string;
  labelClass: string;
  helpClass: string;
}) {
  const labelId = createUniqueId();
  const label = (account: ForgeAccount) => {
    const access = props.pick.access()?.[account.id];
    const name = forgeAccountName(account);
    if (access === "yes") return `${name} (can read it)`;
    if (access === "no") return `${name} (no access)`;
    return name;
  };
  const reach = () => {
    const a = props.pick.access();
    if (!a) return "Checking which accounts can read it.";
    const all = Object.values(a);
    return all.length > 0 && all.every((x) => x === "no") ? "None of these accounts can read it." : null;
  };

  return (
    <Show when={props.pick.choice()}>
      {(c) => (
        <div class={props.fieldClass}>
          <span id={labelId} class={props.labelClass}>
            Account
          </span>
          <Select
            aria-labelledby={labelId}
            placeholder="Pick an account"
            options={c().accounts.map((a) => ({ value: a.id, label: label(a) }))}
            value={props.pick.picked() ?? ""}
            onChange={props.pick.choose}
          />
          <Show when={reach()}>{(line) => <div class={props.helpClass}>{line()}</div>}</Show>
          <Show when={c().overHttps && !c().gitCredentials}>
            <div class={props.helpClass}>
              Cloning over HTTPS turns on Tori sign-in for {c().host}, so its other repos sign in through Tori too.
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}

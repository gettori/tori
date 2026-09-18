import { createEffect, createSignal, on } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { ForgeHost, SignInStart } from "../../utils/forgeTypes";
import { noteForgeAccounts, resetForgeResolutions } from "../../utils/forgeStatus";
import DeviceWaitCard from "../Settings/panes/IntegrationsPane/DeviceWaitCard";
import { asFailure, createDeviceFlow } from "../Settings/panes/IntegrationsPane/deviceFlow";
import { CLOUDS, type Cloud, type Failure } from "../Settings/panes/IntegrationsPane/forgeAddFlow";
import HostsStep, { signedInOn } from "./steps/HostsStep";

/** A factory like the other steps, so the rail can read who is signed in. */
export function createHostsSetup(opts: { onScreen: () => boolean }) {
  const [hosts, setHosts] = createSignal<ForgeHost[]>([]);
  const [waitingFor, setWaitingFor] = createSignal<Cloud | null>(null);
  const [failure, setFailure] = createSignal<{ cloud: Cloud; failure: Failure } | null>(null);
  const [signInTried, setSignInTried] = createSignal(false);

  const device = createDeviceFlow({
    onAuthorized: ({ accountId }) => {
      const cloud = waitingFor();
      setWaitingFor(null);
      void useForGit(cloud, accountId);
    },
    onFailed: (f) => {
      const cloud = waitingFor();
      setWaitingFor(null);
      if (cloud) setFailure({ cloud, failure: f });
    },
  });

  // Leaving the step ends a sign-in still waiting, and coming back reads the
  // accounts again, in case one landed as the step was left.
  createEffect(on(opts.onScreen, (shown) => (shown ? void refresh() : cancel())));

  // As Settings > Hosts does: the poll store hears about accounts from whoever
  // changes them, so the sidebar's chips appear without waiting for a focus.
  async function refresh() {
    const list = await invoke<ForgeHost[]>("forge_accounts").catch(() => null);
    if (!Array.isArray(list)) return;
    setHosts(list);
    noteForgeAccounts(list.flatMap((h) => h.accounts));
  }

  // Signing in here is for pushing and cloning as the account, which git only
  // does once the host's switch in Settings > Hosts is on.
  async function useForGit(cloud: Cloud | null, accountId: string) {
    await refresh();
    const host = hosts().find((h) => h.host === cloud);
    if (!host || host.gitCredentials) return;
    try {
      // With several accounts and no default, git would still ask which one.
      if (host.accounts.length > 1 && !host.defaultAccount) {
        await invoke("forge_set_default_account", { host: host.host, accountId });
        resetForgeResolutions();
      }
      await invoke("forge_set_git_credentials", { host: host.host, enabled: true });
    } catch {
      // The account is in either way, and the switch stays where Settings > Hosts shows it.
    }
    await refresh();
  }

  async function signIn(cloud: Cloud) {
    setSignInTried(true);
    setFailure(null);
    setWaitingFor(cloud);
    device.cancel();
    // An account the host stopped accepting is signed in again in place, not
    // added beside itself.
    const stale = hosts().find((h) => h.host === cloud)?.accounts[0];
    try {
      const start = await invoke<SignInStart>("forge_sign_in_start", {
        ...CLOUDS[cloud],
        accountId: stale?.id ?? null,
      });
      // Reading the user's `gh` login finishes without a card, and pasting a
      // token is not something first run asks for: Settings > Hosts is where
      // that belongs, so the step just says so and moves on.
      if (start.kind === "signedIn") {
        setWaitingFor(null);
        return void useForGit(cloud, start.accountId);
      }
      if (start.kind === "token") {
        setWaitingFor(null);
        return setFailure({ cloud, failure: { kind: "needsToken", host: start.routes.host } });
      }
      void device.resume(start.prompt);
    } catch (e) {
      setWaitingFor(null);
      setFailure({ cloud, failure: asFailure(e) });
    }
  }

  function cancel() {
    device.cancel();
    setWaitingFor(null);
  }

  const signedIn = () =>
    (Object.keys(CLOUDS) as Cloud[]).flatMap((cloud) =>
      signedInOn(hosts(), cloud).map((a) => ({ host: cloud, login: a.login ?? a.label })),
    );

  const summary = () => {
    const connected = [...new Set(signedIn().map((a) => a.host))];
    return connected.length > 0 ? connected.join(", ") : null;
  };

  const view = () => (
    <HostsStep
      hosts={hosts()}
      waitingFor={waitingFor()}
      failure={failure()}
      lifetimeSecs={device.lifetimeSecs()}
      wait={
        <DeviceWaitCard
          host={waitingFor() ?? ""}
          prompt={device.prompt()}
          remainingMs={device.remainingMs()}
          clipboardOk={device.clipboardOk()}
          onCopyAgain={() => void device.copyAgain()}
          onCancel={cancel}
        />
      }
      onSignIn={(cloud) => void signIn(cloud)}
    />
  );

  return { view, summary, signedIn, signInTried };
}

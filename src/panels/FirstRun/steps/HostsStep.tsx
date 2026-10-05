import { For, Match, Show, Switch, type JSX } from "solid-js";
import Button from "../../../components/Button/Button";
import { GitHubLogo, GitLabLogo } from "../../../components/Icon/gitMarks";
import type { ForgeAccount, ForgeHost } from "../../../utils/forgeTypes";
import { failureText } from "../../Settings/panes/IntegrationsPane/deviceFlow";
import type { Cloud, Failure } from "../../Settings/panes/IntegrationsPane/forgeAddFlow";
import styles from "../FirstRun.module.css";

export const HOSTS_LEAD =
  "Pushes, fetches and pull requests on the host go out as this account, from Tori's terminals and from the agents, so the next step can clone a private repo over https. Sign-in opens your browser with a code to paste.";

const CARDS: { cloud: Cloud; name: string; mark: (size: string) => JSX.Element }[] = [
  { cloud: "github.com", name: "GitHub", mark: (size) => <GitHubLogo size={size} /> },
  { cloud: "gitlab.com", name: "GitLab", mark: (size) => <GitLabLogo size={size} /> },
];

export const signedInOn = (hosts: ForgeHost[], cloud: Cloud): ForgeAccount[] =>
  (hosts.find((h) => h.host === cloud)?.accounts ?? []).filter((a) => a.auth.kind === "signedIn");

function initials(account: ForgeAccount): string {
  return (account.login ?? account.label)
    .replace(/[^0-9A-Za-z]/g, "")
    .slice(0, 2)
    .toUpperCase();
}

export default function HostsStep(props: {
  hosts: ForgeHost[];
  waitingFor: Cloud | null;
  failure: { cloud: Cloud; failure: Failure } | null;
  lifetimeSecs: number | null;
  /** The waiting card, which takes the whole row. */
  wait: JSX.Element;
  onSignIn: (cloud: Cloud) => void;
}) {
  return (
    <>
      <div class={styles.hostCards}>
        <For each={CARDS}>
          {(card) => (
            <Show when={props.waitingFor !== card.cloud} fallback={<div class={styles.hostWait}>{props.wait}</div>}>
              <div class={styles.hostCard}>
                <div class={styles.hostHead}>
                  <span class={styles.hostMark} aria-hidden="true">
                    {card.mark("calc(16px * var(--ui-scale))")}
                  </span>
                  <span class={styles.hostText}>
                    <span class={styles.hostName}>{card.name}</span>
                    <span class={styles.hostDomain}>{card.cloud}</span>
                  </span>
                </div>
                <Switch
                  fallback={
                    <Button
                      class={styles.hostButton}
                      variant={card.cloud === "github.com" ? "primary" : "default"}
                      disabled={props.waitingFor !== null}
                      onClick={() => props.onSignIn(card.cloud)}
                    >
                      Sign in
                    </Button>
                  }
                >
                  <Match when={signedInOn(props.hosts, card.cloud).length > 0}>
                    <For each={signedInOn(props.hosts, card.cloud)}>
                      {(account) => (
                        <div class={styles.hostAccount}>
                          <span class={styles.avatar} aria-hidden="true">
                            {initials(account)}
                          </span>
                          <span class={styles.hostText}>
                            <span class={styles.hostLogin}>@{account.login ?? account.label}</span>
                            <Show when={account.scopes?.length}>
                              <span class={styles.hostScopes}>{account.scopes!.join(", ")}</span>
                            </Show>
                          </span>
                        </div>
                      )}
                    </For>
                  </Match>
                  <Match when={props.failure?.cloud === card.cloud && props.failure}>
                    {(f) => (
                      <>
                        <div class={styles.hostError}>
                          <div class={styles.hostErrorTitle}>
                            {f().failure.kind === "needsToken" ? "Not from here" : "Sign-in did not complete"}
                          </div>
                          <div>{failureText(card.cloud, f().failure, props.lifetimeSecs)}</div>
                        </div>
                        {/* Trying again would take the same route to the same
                            sentence: the token this host needs is asked for in
                            Settings, which this step cannot open. */}
                        <Show when={f().failure.kind !== "needsToken"}>
                          <Button
                            class={styles.hostButton}
                            disabled={props.waitingFor !== null}
                            onClick={() => props.onSignIn(card.cloud)}
                          >
                            Try again
                          </Button>
                        </Show>
                      </>
                    )}
                  </Match>
                </Switch>
              </div>
            </Show>
          )}
        </For>
      </div>
      <div class={styles.hint}>Other hosts and token sign-in: Settings &gt; Hosts</div>
    </>
  );
}

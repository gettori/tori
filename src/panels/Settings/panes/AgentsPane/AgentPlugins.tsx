import { For, Show, createResource, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import styles from "../../Settings.module.css";

/** Mirrors `crate::agent_plugins::InstalledPlugin`. */
export type InstalledPlugin = {
  id: string;
  name: string;
  marketplace: string | null;
  version: string | null;
  scope: string | null;
  installPath: string | null;
  enabled: boolean;
};

/** Mirrors `crate::agent_plugins::ProfilePluginsView`. */
export type ProfilePluginsView = {
  profileId: string;
  label: string;
  home: string;
  plugins: InstalledPlugin[];
};

/** Mirrors `crate::agent_plugins::PluginsView`. */
export type PluginsView = {
  adapterId: string;
  declared: boolean;
  profiles: ProfilePluginsView[];
};

/** Where it came from and at what scope, as one short fact beside the name. */
function origin(p: InstalledPlugin): string {
  return [p.marketplace, p.scope].filter(Boolean).join(", ");
}

/**
 * What each account of this agent has installed, read off its home.
 *
 * The same shape as the Files group above it: one account at a time, tabs
 * only once there are two, the home path as the card's heading. Read-only,
 * because installing is the agent's own command and Tori runs none of them
 * on the user's behalf.
 */
export default function AgentPlugins(props: {
  agentId: string;
  /** Bumped by the accounts list when an account is added or removed, so the
   *  homes are re-resolved against the new set. */
  accountsNonce?: number;
}) {
  const [view] = createResource(
    () => `${props.agentId}:${props.accountsNonce ?? 0}`,
    (key) => invoke<PluginsView>("agent_plugins", { adapterId: key.split(":")[0] }),
  );

  const profiles = () => view()?.profiles ?? [];
  const [picked, setPicked] = createSignal<string | null>(null);
  const shown = () => profiles().find((p) => p.profileId === picked()) ?? profiles()[0];

  return (
    <Show when={view()?.declared}>
      <div class={styles.groupHead}>
        <span class={styles.groupTitle}>Plugins</span>
        <span class={styles.sectionRule} />
        <Show when={profiles().length > 1}>
          <div class={styles.groupTabs}>
            <For each={profiles()}>
              {(profile) => (
                <button
                  type="button"
                  class={styles.groupTab}
                  aria-pressed={profile.profileId === shown()?.profileId}
                  onClick={() => setPicked(profile.profileId)}
                >
                  {profile.label}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
      <Show when={shown()}>
        {(profile) => (
          <div class={styles.accountsCard}>
            <div class={styles.acctHead}>
              <span class={styles.acctHome}>{profile().home}</span>
            </div>
            <Show
              when={profile().plugins.length}
              fallback={<div class={styles.cardMeta}>No plugins installed for this account.</div>}
            >
              <ul class={styles.modelList}>
                <For each={profile().plugins}>
                  {(p) => (
                    <li class={styles.modelRow} title={p.installPath ?? undefined}>
                      <span class={styles.modelName}>{p.name}</span>
                      <Show when={p.version}>{(v) => <code class={styles.modelId}>{v()}</code>}</Show>
                      {/* Installed and switched off is a state the agent's own
                          list reports, so it is shown rather than dropped. */}
                      <Show when={!p.enabled}>
                        <span class={styles.chip}>off</span>
                      </Show>
                      <Show when={origin(p)}>
                        <span class={styles.modelEffort}>{origin(p)}</span>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        )}
      </Show>
    </Show>
  );
}

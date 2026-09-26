import type { RemoteClient } from "./remote";
import styles from "./mobile.module.css";

export default function SettingsScreen(props: { client: RemoteClient; onDisconnect: () => void; onBack: () => void }) {
  return (
    <div class={styles.screen}>
      <header class={styles.bar}>
        <button class={styles.back} onClick={() => props.onBack()}>
          Back
        </button>
        <span class={styles.title}>Settings</span>
      </header>
      <dl class={styles.facts}>
        <dt>Tori</dt>
        <dd>{props.client.saved.url}</dd>
        <dt>This phone</dt>
        <dd>{props.client.saved.name}</dd>
        <dt>Connection</dt>
        <dd>{props.client.status()}</dd>
      </dl>
      <div class={styles.actions}>
        <button class={styles.danger} onClick={() => props.onDisconnect()}>
          Disconnect
        </button>
        <p class={styles.hint}>Forgets this Tori on the phone. Remove the phone under Settings, Remote on the Mac too.</p>
      </div>
    </div>
  );
}

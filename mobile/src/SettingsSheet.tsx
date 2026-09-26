import { WheelGlyph } from "../../src/components/Autopilot/Wheel";
import { setShowWheel, setTheme, showWheel, theme } from "./prefs";
import type { RemoteClient } from "./remote";
import styles from "./shell.module.css";

export default function SettingsSheet(props: { client: RemoteClient; onDone: () => void; onDisconnect: () => void }) {
  return (
    <>
      <div class={styles.dim} onClick={() => props.onDone()} />
      <section class={styles.sheet} role="dialog" aria-label="Settings">
        <span class={styles.grabber} />
        <header class={styles.sheetHead}>
          <span class={styles.sheetTitle}>Settings</span>
          <button class={styles.done} onClick={() => props.onDone()}>
            Done
          </button>
        </header>
        <div class={styles.sheetBody}>
          <h2 class={styles.label}>Connection</h2>
          <ul class={styles.group}>
            <li>
              <div class={`${styles.item} ${styles.setting}`}>
                <span class={styles.text}>Tori</span>
                <span class={styles.value}>{props.client.saved.url}</span>
              </div>
            </li>
            <li>
              <div class={`${styles.item} ${styles.setting}`}>
                <span class={styles.text}>This phone</span>
                <span class={styles.value}>{props.client.saved.name}</span>
              </div>
            </li>
            <li>
              <div class={`${styles.item} ${styles.setting}`}>
                <span class={styles.text}>Status</span>
                <span class={styles.value}>{props.client.status()}</span>
              </div>
            </li>
            <li>
              <button class={`${styles.item} ${styles.setting} ${styles.disconnect}`} onClick={() => props.onDisconnect()}>
                Disconnect
              </button>
            </li>
          </ul>
          <p class={styles.footnote}>Disconnect forgets this Tori on the phone. Remove the phone under Settings, Remote on the Mac too.</p>

          <h2 class={styles.label}>Appearance</h2>
          <ul class={styles.group}>
            <li>
              <div class={`${styles.item} ${styles.setting}`}>
                <span class={styles.text}>Theme</span>
                <span class={styles.segments}>
                  <button aria-pressed={theme() === "dark"} onClick={() => setTheme("dark")}>
                    Dark
                  </button>
                  <button aria-pressed={theme() === "light"} onClick={() => setTheme("light")}>
                    Light
                  </button>
                </span>
              </div>
            </li>
          </ul>
          <p class={styles.footnote}>Tori Dark or Tori Light, kept on this phone.</p>

          <h2 class={styles.label}>Autopilot</h2>
          <ul class={styles.group}>
            <li>
              <button class={styles.item} onClick={() => setShowWheel(!showWheel())}>
                <span class={styles.wheelTile}>
                  <WheelGlyph size={17} />
                </span>
                <span class={styles.text}>Autopilot button</span>
                <span class={styles.toggle} role="switch" aria-checked={showWheel()} />
              </button>
            </li>
          </ul>
          <p class={styles.footnote}>Shows the wheel in the bottom bar. Tap it to open the autopilot chat and turn it on or off.</p>
        </div>
      </section>
    </>
  );
}

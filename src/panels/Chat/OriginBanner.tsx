import { Show, createEffect, on } from "solid-js";
import { emitWith, NAVIGATE, type NavTarget } from "../../utils/events";
import { unitAt } from "../../utils/sessionActivity";
import { loadOrigin, madeByParts } from "../../utils/unitOrigin";
import styles from "./Chat.module.css";

export default function OriginBanner(props: { workspace: string; sessionId: string }) {
  const origin = () => {
    const made = unitAt(props.workspace)?.madeBy;
    return made && made.session !== props.sessionId ? made : null;
  };
  createEffect(on(origin, (o) => o && loadOrigin(o)));
  const parts = () => {
    const o = origin();
    return o ? madeByParts(o) : null;
  };

  return (
    <Show when={origin()}>
      {(o) => (
        <div class={`${styles.banner} ${styles.bannerQuiet}`} data-origin-banner="">
          <span class={styles.bannerText}>
            Made by{" "}
            <button
              type="button"
              class={styles.originLink}
              onClick={() => emitWith<NavTarget>(NAVIGATE, { session: o().session, folder: o().workspace })}
            >
              {parts()?.name}
            </button>{" "}
            in {parts()?.where}
          </span>
        </div>
      )}
    </Show>
  );
}

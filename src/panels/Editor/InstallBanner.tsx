import { Match, Show, Switch } from "solid-js";
import Button from "../../components/Button/Button";
import { dismissOffer, installServer, offerFor } from "../../utils/serverInstall";
import { neverOfferInstall, settings } from "../Settings/settingsStore";
import styles from "./CodeEditor.module.css";

/** The offer to install the language server the pane's file asked for, and
 *  how that install is going. */
export default function InstallBanner(props: { path: string | null }) {
  const offer = () => {
    const o = offerFor(props.path);
    return o && !(settings.lsp?.neverOffer ?? []).includes(o.serverId) ? o : null;
  };
  // A failure is shown by the offer itself.
  const install = (serverId: string) => void installServer(serverId).catch(() => {});
  const never = (serverId: string) => {
    neverOfferInstall(serverId);
    dismissOffer(serverId);
  };

  return (
    <Show when={offer()}>
      {(o) => (
        <div class={styles.installBanner} role="status">
          <Switch>
            <Match when={o().status === "installing"}>
              <span>Installing {o().label}. A large server can take a minute to download.</span>
            </Match>
            <Match when={o().status === "failed"}>
              <span>
                Could not install {o().label}: {o().error}
              </span>
              <Button size="sm" onClick={() => install(o().serverId)}>Try again</Button>
              <Button size="sm" onClick={() => dismissOffer(o().serverId)}>Not now</Button>
            </Match>
            <Match when={o().status === "offered"}>
              <span>Tori can install {o().label} for completion and diagnostics in this file.</span>
              <Button size="sm" variant="primary" onClick={() => install(o().serverId)}>Install</Button>
              <Button size="sm" onClick={() => dismissOffer(o().serverId)}>Not now</Button>
              <Button size="sm" onClick={() => never(o().serverId)}>Never for this language</Button>
            </Match>
          </Switch>
        </div>
      )}
    </Show>
  );
}

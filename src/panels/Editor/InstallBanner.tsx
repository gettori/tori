import { createResource, createSignal, Match, Show, Switch } from "solid-js";
import Button from "../../components/Button/Button";
import { answerCatalogOffer, catalogOfferAnswered, catalogPackFor } from "../../utils/catalogOffers";
import { extensionOf, hasServerFor, servers } from "../../utils/lspServers";
import { requestPackInstall } from "../../utils/packInstall";
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

  // A loaded server, switched off or not, claims the extension: no pack is
  // offered over it, and none before the registry has said what is loaded.
  const unclaimed = () => {
    const path = props.path;
    const ext = path ? extensionOf(path) : null;
    return ext && servers().length > 0 && !hasServerFor(path!) ? ext : null;
  };
  const [pack] = createResource(unclaimed, (ext) => catalogPackFor("lsp", ext));
  const [answered, setAnswered] = createSignal(0);
  const packOffer = () => {
    answered();
    const p = pack();
    const never = settings.lsp?.neverOffer ?? [];
    return p && !catalogOfferAnswered("lsp", p.id) && !never.includes(p.id) ? p : null;
  };
  const answer = (id: string) => {
    answerCatalogOffer("lsp", id);
    setAnswered((n) => n + 1);
  };

  return (
    <Show
      when={offer()}
      fallback={
        <Show when={packOffer()}>
          {(p) => (
            <div class={styles.installBanner} role="status">
              <span>Tori has a language server pack for this file: {p().label ?? p().id}.</span>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  const id = p().id;
                  if (requestPackInstall({ kind: "lsp", id, origin: "editor" })) answer(id);
                }}
              >
                Get
              </Button>
              <Button size="sm" onClick={() => answer(p().id)}>
                Not now
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  const id = p().id;
                  neverOfferInstall(id);
                  answer(id);
                }}
              >
                Never for this language
              </Button>
            </div>
          )}
        </Show>
      }
    >
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
              <Button size="sm" onClick={() => install(o().serverId)}>
                Try again
              </Button>
              <Button size="sm" onClick={() => dismissOffer(o().serverId)}>
                Not now
              </Button>
            </Match>
            <Match when={o().status === "offered"}>
              <span>Tori can install {o().label} for completion and diagnostics in this file.</span>
              <Button size="sm" variant="primary" onClick={() => install(o().serverId)}>
                Install
              </Button>
              <Button size="sm" onClick={() => dismissOffer(o().serverId)}>
                Not now
              </Button>
              <Button size="sm" onClick={() => never(o().serverId)}>
                Never for this language
              </Button>
            </Match>
          </Switch>
        </div>
      )}
    </Show>
  );
}

import { Show } from "solid-js";
import PaneView from "../tabs/PaneView";
import { tabsIn } from "../panels/Terminal/terminalTabStore";
import { SHELLS_KEY } from "../utils/features";
import { shellsPane } from "./shellsWorkspace";

export default function Dock() {
  return (
    <>
      <PaneView pinKind="command" paneId={shellsPane() ?? undefined} ws={SHELLS_KEY} />
      <Show when={tabsIn(SHELLS_KEY).length === 0}>
        <div class="dock-empty">Nothing running. Clones, bootstraps, installs and sign-ins show up here.</div>
      </Show>
    </>
  );
}

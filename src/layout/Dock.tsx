import { Show } from "solid-js";
import { Plus } from "lucide-solid";
import Icon from "../components/Icon/Icon";
import IconButton from "../components/IconButton/IconButton";
import PaneView from "../tabs/PaneView";
import { tabsIn } from "../panels/Terminal/terminalTabStore";
import { SHELLS_KEY } from "../utils/features";
import { emit, NEW_DOCK_SHELL } from "../utils/events";
import { shellsPane } from "./shellsWorkspace";

export default function Dock() {
  return (
    <>
      <PaneView
        pinKind="command"
        paneId={shellsPane() ?? undefined}
        ws={SHELLS_KEY}
        trailing={
          <IconButton
            icon={<Icon icon={Plus} />}
            tooltip="New shell at your home folder"
            aria-label="New shell"
            onClick={() => emit(NEW_DOCK_SHELL)}
          />
        }
      />
      <Show when={tabsIn(SHELLS_KEY).length === 0}>
        <div class="dock-empty">Nothing running. Clones, bootstraps, installs and sign-ins show up here.</div>
      </Show>
    </>
  );
}

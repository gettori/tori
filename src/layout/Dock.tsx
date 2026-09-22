import { Show } from "solid-js";
import { Plus, X } from "lucide-solid";
import Icon from "../components/Icon/Icon";
import IconButton from "../components/IconButton/IconButton";
import PaneView from "../tabs/PaneView";
import { tabsIn } from "../panels/Terminal/terminalTabStore";
import { SHELLS_KEY } from "../utils/topics";
import { emit, NEW_DOCK_SHELL } from "../utils/events";
import { shellsPane } from "./shellsWorkspace";
import { showDock } from "./dockStore";

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
        end={
          <IconButton
            icon={<Icon icon={X} />}
            tooltip="Hide the dock"
            aria-label="Hide the dock"
            onClick={() => showDock(false)}
          />
        }
      />
      <Show when={tabsIn(SHELLS_KEY).length === 0}>
        <div class="dock-empty">Nothing running. Clones, bootstraps, installs and sign-ins show up here.</div>
      </Show>
    </>
  );
}

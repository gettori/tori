import { PanelLeft } from "../Icon/icons";
import { ToggleGroup } from "../ToggleGroup/ToggleGroup";
import Icon from "../Icon/Icon";
import IconButton from "../IconButton/IconButton";
import { emit, TOGGLE_SIDEBAR } from "../../utils/events";
import styles from "./LayoutToggles.module.css";

// The look keys off `data-pressed` in CSS because a passed class would be
// clobbered by IconButton's own class handling.
export default function LayoutToggles(props: { showSidebar: boolean }) {
  return (
    <ToggleGroup.Root pressed={() => props.showSidebar} onPress={() => emit(TOGGLE_SIDEBAR)} class={styles.cluster}>
      <ToggleGroup.Item
        as={IconButton}
        value="sidebar"
        size="md"
        class={styles.item}
        icon={<Icon icon={PanelLeft} />}
        tooltip="Show or hide the sidebar (⌘B)"
      />
    </ToggleGroup.Root>
  );
}

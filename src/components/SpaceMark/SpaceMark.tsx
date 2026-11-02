import { Show } from "solid-js";
import Icon from "../Icon/Icon";
import { resolveIcon } from "../Icon/iconRegistry";
import { spaceHueRgb } from "../../utils/spaceTint";
import { spaceInitials } from "../../utils/names";
import styles from "./SpaceMark.module.css";

export default function SpaceMark(props: { name: string; icon?: string | null; color?: string | null }) {
  return (
    // Decorative: the space's name always sits beside it.
    <span class={styles.mark} style={{ "--space-hue-rgb": spaceHueRgb(props.name, props.color) }} aria-hidden="true">
      <Show when={resolveIcon(props.icon)} fallback={spaceInitials(props.name)}>
        {(glyph) => <Icon icon={glyph()} />}
      </Show>
    </span>
  );
}

import { Show } from "solid-js";
import { type LucideIcon } from "lucide-solid";
import ContextMenu from "../../components/Menu/ContextMenu";
import { type MenuItem } from "../../components/Menu/rows";
import Tooltip from "../../components/Tooltip/Tooltip";
import Icon from "../../components/Icon/Icon";
import { resolveIcon } from "../../components/Icon/iconRegistry";
import { spaceHueRgb } from "../../utils/spaceTint";
import { spaceInitials } from "../../utils/names";
import type { Rollup } from "../../utils/sessionStatus";
import StatusBubble from "./StatusBubble";
import styles from "./SpaceTile.module.css";

/**
 * One space tile for the bottom bar: its icon when set, else the name's
 * initial; active-marked, with its context menu and drag payload. It carries
 * its own hue too, so the whole set of spaces is legible at once rather than
 * one switch at a time.
 *
 * The one row whose menu trigger cannot be the row itself. `Tooltip` and
 * `ContextMenu` both render *as* their control - each puts its handlers on the
 * element, and neither can inject them into an already-built JSX child - so the
 * tile can only be one of them. It stays the Tooltip's, and the menu takes a
 * `display: contents` wrapper: layout-neutral, and it still receives the
 * right-click on its way up. Nothing is lost positionally either, since a
 * context menu anchors on the cursor and never on its trigger's box.
 */
export default function SpaceTile(props: {
  name: string;
  /** A Lucide name from the icon registry. Absent falls back to the initials. */
  icon?: string;
  /** A swatch name; absent means the hue is derived from `name`. */
  color?: string;
  /** The measured width of this tile's own name, for the pill's open state. */
  nameWidth?: string;
  /** Lit: the tree below is showing this space. */
  active?: boolean;
  dragging?: boolean;
  dropBefore?: boolean;
  dropAfter?: boolean;
  menu?: MenuItem[];
  rollup?: () => Rollup | null;
  onClick?: () => void;
  onDragStart?: (e: DragEvent) => void;
  onDragOver?: (e: DragEvent) => void;
  onDrop?: (e: DragEvent) => void;
  onDragEnd?: () => void;
}) {
  return (
    <ContextMenu class={styles.spaceMenu} items={props.menu ?? []}>
      <Tooltip
        as="button"
        type="button"
        class={styles.space}
        style={{
          "--space-hue-rgb": spaceHueRgb(props.name, props.color),
          "--name-w": props.nameWidth,
        }}
        classList={{
          [styles.active]: props.active,
          [styles.titled]: props.active,
          [styles.dragging]: props.dragging,
          [styles.dropBefore]: props.dropBefore,
          [styles.dropAfter]: props.dropAfter,
        }}
        label={props.name}
        aria-label={props.name}
        aria-pressed={props.active}
        onClick={() => props.onClick?.()}
        draggable={true}
        onDragStart={(e: DragEvent) => props.onDragStart?.(e)}
        onDragOver={(e: DragEvent) => props.onDragOver?.(e)}
        onDrop={(e: DragEvent) => props.onDrop?.(e)}
        onDragEnd={() => props.onDragEnd?.()}
      >
        <Show when={resolveIcon(props.icon)} fallback={spaceInitials(props.name)}>
          {(glyph) => <Icon icon={glyph()} />}
        </Show>
        {/* Always mounted; the 0fr track hides it. See .tileName. */}
        <span class={styles.tileName}><span class={styles.tileNameText}>{props.name}</span></span>
        <Show when={props.rollup}>{(get) => <StatusBubble rollup={get()} tile />}</Show>
      </Tooltip>
    </ContextMenu>
  );
}

/** A sidebar mode (Topics), as a tile in the same strip and on the same rules
 *  as a space: bare glyph at rest, name and pill when the tree is showing it.
 *  No menu and no rollup, because a mode is not a thing you can act on or that
 *  can hide sessions from you. */
export function ModeTile(props: {
  label: string;
  glyph: LucideIcon;
  nameWidth?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <Tooltip
      as="button"
      type="button"
      class={`${styles.space} ${styles.modeTile}`}
      style={{ "--name-w": props.nameWidth }}
      classList={{ [styles.active]: props.active, [styles.titled]: props.active }}
      label={props.label}
      aria-label={props.label}
      aria-pressed={props.active}
      onClick={() => props.onClick?.()}
    >
      <Icon icon={props.glyph} />
      <span class={styles.tileName}><span class={styles.tileNameText}>{props.label}</span></span>
    </Tooltip>
  );
}

/** Out of flow and never seen: the ruler each candidate name is run through,
 *  wearing the real lit-tile CSS so what it reports is what the row would
 *  actually take. The caller owns the measuring pass and so owns the refs. */
export function TileProbe(props: {
  glyph: LucideIcon;
  ref?: (el: HTMLSpanElement) => void;
  nameRef?: (el: HTMLSpanElement) => void;
  textRef?: (el: HTMLSpanElement) => void;
}) {
  return (
    <span
      class={`${styles.space} ${styles.titled} ${styles.tileProbe}`}
      aria-hidden="true"
      ref={props.ref}
    >
      <Icon icon={props.glyph} />
      <span class={styles.tileName} ref={props.nameRef}>
        <span class={styles.tileNameText} ref={props.textRef} />
      </span>
    </span>
  );
}

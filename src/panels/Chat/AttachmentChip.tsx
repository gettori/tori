import { For, Show, type JSX } from "solid-js";
import { X } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import Tooltip from "../../components/Tooltip/Tooltip";
import FileIcon from "../../seti/FileIcon";
import { chipLabel } from "../../utils/chatCompose";
import type { ContentBlock } from "../../utils/chatTypes";
import Tip from "./Tip";
import { attachmentTip, isTile, thumbSrc, tileName, tileNote, tokenOf } from "./attachmentInfo";
import styles from "./Chat.module.css";

/**
 * A chip of this composer's own, on its way into the sentence.
 *
 * Private, and checked before the path MIMEs: the tree marks its drags with
 * `text/plain` as well, and a chip read as a path would attach the same file a
 * second time under a second number.
 */
export const ATTACHMENT_TOKEN_MIME = "application/x-tori-attachment-token";

export type HeldBlock = { id: string; block: ContentBlock };

/** Tiles and pills in grids of their own, so the two shapes never share a row
 *  and every cell in a row is the same width. */
export function AttachmentGrid(props: { items: readonly HeldBlock[]; chip: (a: HeldBlock) => JSX.Element }) {
  const tiles = () => props.items.filter((a) => isTile(a.block));
  const pills = () => props.items.filter((a) => !isTile(a.block));
  return (
    <Show when={props.items.length}>
      <div class={styles.attachments}>
        <Show when={tiles().length}>
          <div class={styles.attachmentTiles}>
            <For each={tiles()}>{(a) => props.chip(a)}</For>
          </div>
        </Show>
        <Show when={pills().length}>
          <div class={styles.attachmentPills}>
            <For each={pills()}>{(a) => props.chip(a)}</For>
          </div>
        </Show>
      </div>
    </Show>
  );
}

/** One attachment above the text. Without `onRemove` it is a record of what a
 *  sent prompt carried: it previews, and cannot be taken away or dragged. */
export function AttachmentChip(props: {
  block: ContentBlock;
  missing?: boolean;
  pointed?: boolean;
  onPreview: () => void;
  onRemove?: () => void;
  /** Name it in the message, by Cmd+click. Also what makes it draggable. */
  onInsert?: (token: string) => void;
}) {
  const block = props.block;
  // A tile is its picture, or its Seti icon in the same box, above its name.
  // A pill is prose (a hunk comment, a diagnostic) or a link with no file.
  const src = thumbSrc(block);
  const path = block.type === "fileRef" ? block.path : null;
  const token = props.onInsert ? tokenOf(block) : null;
  const name = tileName(block);
  const note = tileNote(block);
  const tile = isTile(block);
  const reason = () => (props.missing && path ? `. No file at ${path}` : "");
  return (
    <div
      class={styles.attachment}
      classList={{
        [styles.attachmentTile]: tile,
        [styles.attachmentMissing]: !!props.missing,
        [styles.attachmentPointed]: !!props.pointed,
      }}
    >
      {/* Two controls, because the chip means two things: look at it, or take
          it away. Cmd+click keeps the tile's other job of naming it in the
          sentence, for one that has a token to name it by. */}
      <Tooltip
        as="button"
        type="button"
        class={styles.attachmentBody}
        label={<Tip {...attachmentTip(block, { missing: props.missing, nameable: token !== null })} />}
        aria-label={`Preview ${chipLabel(block)}${reason()}`}
        draggable={token !== null}
        onDragStart={(e: DragEvent) => {
          if (!token) return;
          e.dataTransfer?.setData(ATTACHMENT_TOKEN_MIME, token);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
        }}
        onClick={(e: MouseEvent) => {
          if (e.metaKey && token) props.onInsert?.(token);
          else props.onPreview();
        }}
        // The keyboard's way to the remove button's job, on the control the
        // focus is already on.
        onKeyDown={(e: KeyboardEvent) => {
          if (!props.onRemove || (e.key !== "Delete" && e.key !== "Backspace")) return;
          e.preventDefault();
          props.onRemove();
        }}
      >
        <Show when={tile} fallback={<span class={styles.attachmentName}>{name}</span>}>
          <span class={styles.attachmentPreview}>
            {src ? <img class={styles.attachmentThumb} src={src} alt="" /> : <FileIcon name={name} />}
          </span>
          <span class={styles.attachmentName}>{name}</span>
          <Show when={note}>
            <span class={styles.attachmentNote}>{note}</span>
          </Show>
        </Show>
      </Tooltip>
      <Show when={props.onRemove}>
        {(remove) => (
          <button
            type="button"
            class={styles.attachmentRemove}
            // Named after the action and after which attachment: an image
            // chip's own content is a picture, so without this the button
            // answers to nothing.
            aria-label={`Remove ${chipLabel(block)}${reason()}`}
            onClick={() => remove()()}
          >
            <Icon icon={X} size={12} aria-hidden="true" />
          </button>
        )}
      </Show>
    </div>
  );
}

/** A token in the sentence that is one of the held attachments. It reads as the
 *  text it is; hovering lights the attachment it names above, which already
 *  says everything a tooltip would. */
export function InlineChip(props: {
  label: string;
  block: ContentBlock;
  missing?: boolean;
  onPoint: (on: boolean) => void;
  onPreview: () => void;
  /** Present where the token can be picked up and moved. */
  onDragStart?: (e: DragEvent) => void;
  onDragEnd?: () => void;
}) {
  return (
    <button
      type="button"
      class={styles.inlineChip}
      classList={{ [styles.inlineChipMissing]: !!props.missing, [styles.inlineChipFixed]: !props.onDragStart }}
      aria-label={`Preview ${chipLabel(props.block)}`}
      onMouseEnter={() => props.onPoint(true)}
      onMouseLeave={() => props.onPoint(false)}
      // Out of the tab order: the field is one stop, and the chip's file is
      // reachable from its tile above.
      tabIndex={-1}
      draggable={!!props.onDragStart}
      onDragStart={(e: DragEvent) => props.onDragStart?.(e)}
      onDragEnd={() => props.onDragEnd?.()}
      onClick={() => props.onPreview()}
    >
      {props.label}
    </button>
  );
}

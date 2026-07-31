import { Show } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
import Icon from "./Icon";
import { resolveIcon, fallbackIcon } from "./iconRegistry";

/** Everything a project row knows about its own icon. The three optional fields
 *  come straight from discovery (`Project` in config.rs); `seed` is the
 *  project's absolute path, which is what the derived glyph is hashed on. */
export interface ProjectIconSource {
  /** An image the user uploaded (absolute path). Wins over everything. */
  iconFile?: string;
  /** A Lucide name the user picked. */
  icon?: string;
  /** The favicon discovery found inside the project (absolute path). */
  favicon?: string;
  seed: string;
}

/** The glyph or image for a project, resolved in one place so the sidebar row,
 *  the picker's preview and anything else that shows a project agree.
 *
 *  Order: what the user chose (an image, then a glyph), then what the project
 *  says about itself (its favicon), then a glyph derived from the path. There
 *  is no "no icon" state - unlike a space, whose tile can fall back to its
 *  initial, a project row always shows something in its 16px slot.
 *
 *  Local files go through `convertFileSrc`, the same asset-protocol route the
 *  image tab and Markdown preview use; the stored filename carries a hash of the
 *  file's bytes, so a replaced icon is a new URL and never a cached old one. */
export default function ProjectIcon(props: ProjectIconSource) {
  // A stored name the registry does not know (an icon dropped from the set, or a
  // hand-edited typo) resolves to undefined and falls through, rather than
  // rendering nothing at all.
  const picked = () => resolveIcon(props.icon);
  const image = () => props.iconFile || (picked() ? undefined : props.favicon);

  return (
    <Show when={image()} fallback={<Icon icon={picked() ?? fallbackIcon(props.seed)} />}>
      {(src) => <img src={convertFileSrc(src())} alt="" draggable={false} />}
    </Show>
  );
}

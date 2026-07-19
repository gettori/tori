import { convertFileSrc } from "@tauri-apps/api/core";
import styles from "./ImageView.module.css";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);

export function isImagePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}

/** Read-only view for an image file opened from the tree - CodeEditor reads
 *  a file as UTF-8 text, which corrupts binary image data, so an image tab
 *  never goes through it. Loaded via Tauri's asset protocol (convertFileSrc),
 *  the same mechanism MarkdownPreview uses for embedded relative images. */
export default function ImageView(props: { path: string }) {
  return (
    <div class={styles.imageView}>
      <img class={styles.image} src={convertFileSrc(props.path)} alt={props.path} />
    </div>
  );
}

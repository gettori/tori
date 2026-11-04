import { convertFileSrc } from "@tauri-apps/api/core";
import OverlayScroll from "../../components/Scrollbar/OverlayScroll";
import styles from "./ImageView.module.css";

export { isImagePath } from "../../utils/pathScope";

/** Read-only view for an image file opened from the tree - CodeEditor reads
 *  a file as UTF-8 text, which corrupts binary image data, so an image tab
 *  never goes through it. Loaded via Tauri's asset protocol (convertFileSrc),
 *  the same mechanism MarkdownPreview uses for embedded relative images. */
export default function ImageView(props: { path: string }) {
  return (
    <OverlayScroll class={styles.imageView} contentClass={styles.imageContent}>
      <img class={styles.image} src={convertFileSrc(props.path)} alt={props.path} />
    </OverlayScroll>
  );
}

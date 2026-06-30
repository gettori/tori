/** Pi session mark for the sidebar, rendered in the shared `.seti-icon` slot
 *  (same as ClaudeIcon). Drawn as a lowercase π so it reads as the pi agent at a
 *  glance; `fill` is `currentColor` and `.pi-icon` tints it a distinct color,
 *  independent of the row's text/selection color.
 *
 *  NOTE: the project plan referenced an official "provided" pi SVG that was not
 *  in the repo; swap the <path> below for that artwork when available (keep the
 *  `currentColor` fill and the `.seti-icon pi-icon` wrapper). */
export default function PiIcon() {
  return (
    <span class="seti-icon pi-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor">
        <path
          fill-rule="evenodd"
          d="M3.5 6.5a1.25 1.25 0 0 1 1.25-1.25h14.5a1.25 1.25 0 1 1 0 2.5h-1.55v8.3a1.1 1.1 0 0 0 1.1 1.1c.3 0 .57-.12.77-.31a1.1 1.1 0 0 1 1.52 1.58 3.3 3.3 0 0 1-5.59-2.37V7.75h-3.6v9.75a1.25 1.25 0 1 1-2.5 0V7.75H4.75A1.25 1.25 0 0 1 3.5 6.5Z"
        />
      </svg>
    </span>
  );
}

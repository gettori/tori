import { getCurrentWindow } from "@tauri-apps/api/window";

// Custom macOS-style traffic lights: smaller than native, vertically centered,
// and gray until the group is hovered. The native buttons are hidden in Rust
// (see lib.rs setup); these are wired to the same window actions.
export default function WindowControls() {
  const win = getCurrentWindow();
  return (
    <div class="win-controls">
      <button
        class="win-dot close"
        aria-label="Close"
        onClick={() => win.close()}
      />
      <button
        class="win-dot min"
        aria-label="Minimize"
        onClick={() => win.minimize()}
      />
      <button
        class="win-dot zoom"
        aria-label="Zoom"
        onClick={() => win.toggleMaximize()}
      />
    </div>
  );
}

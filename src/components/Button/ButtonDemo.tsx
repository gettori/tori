import { For } from "solid-js";
import Button, { type ButtonVariant, type ButtonSize } from "./Button";

/** TEMP (Phase 1) demo grid: every variant × size × content shape, so the
 *  Button can be eyeballed against its old counterparts. Removed in Phase 4.
 *  Reachable via the `?btn-demo` query flag (see App.tsx). */

const variants: ButtonVariant[] = [
  "default",
  "primary",
  "success",
  "warn",
  "danger",
  "ghost",
];
const sizes: ButtonSize[] = ["md", "sm", "xs"];

function Gear() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.9"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export default function ButtonDemo() {
  return (
    <div
      style={{
        position: "fixed",
        inset: "0",
        "z-index": "9999",
        overflow: "auto",
        background: "var(--bg)",
        color: "var(--text)",
        padding: "24px",
      }}
    >
      <h2 style={{ "margin-bottom": "16px" }}>Button demo (Phase 1)</h2>
      <For each={sizes}>
        {(size) => (
          <section style={{ "margin-bottom": "24px" }}>
            <h3 style={{ "margin-bottom": "8px" }}>size={size}</h3>
            <For each={variants}>
              {(variant) => (
                <div
                  style={{
                    display: "flex",
                    "align-items": "center",
                    gap: "10px",
                    "margin-bottom": "8px",
                  }}
                >
                  <span style={{ width: "80px", "font-size": "12px" }}>
                    {variant}
                  </span>
                  <Button variant={variant} size={size}>
                    Text
                  </Button>
                  <Button variant={variant} size={size} icon={<Gear />}>
                    Icon + text
                  </Button>
                  <Button
                    variant={variant}
                    size={size}
                    icon={<Gear />}
                    aria-label="Settings"
                    title="Settings"
                  />
                </div>
              )}
            </For>
          </section>
        )}
      </For>
    </div>
  );
}

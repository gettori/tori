import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

let held: { kind: string; id: string } | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "packs_take_link") {
      const link = held;
      held = null;
      return Promise.resolve(link);
    }
    return Promise.resolve(null);
  },
}));

const { takePackLink, openPackLink } = await import("./packLink");
const { pendingPackInstall, dismissPackInstall } = await import("./packInstall");
const { TOAST } = await import("./events");

beforeEach(() => {
  dismissPackInstall();
  document.body.innerHTML = "";
});

describe("a pack link", () => {
  it("opens the install dialog for the pack it names, as a link", async () => {
    held = { kind: "themes", id: "nord" };
    openPackLink((await takePackLink())!);
    expect(pendingPackInstall()).toEqual({ kind: "themes", id: "nord", origin: "link" });
  });

  it("is dropped with a toast while a dialog is open", async () => {
    document.body.innerHTML = '<div role="dialog"></div>';
    const toasts: string[] = [];
    window.addEventListener(TOAST, (e) => toasts.push((e as CustomEvent<{ message: string }>).detail.message));
    held = { kind: "themes", id: "nord" };
    openPackLink((await takePackLink())!);
    expect(pendingPackInstall()).toBeNull();
    expect(toasts).toEqual(["Close the open dialog, then use the nord link again."]);
  });
});

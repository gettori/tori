import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, fireEvent, waitFor } from "../../../src/test/harness";
import Options from "./Options";

let answer!: (ok: boolean) => void;
const set = vi.fn(() => new Promise<void>((yes, no) => (answer = (ok) => (ok ? yes() : no(new Error("quota"))))));
vi.stubGlobal("chrome", {
  storage: { local: { get: async () => ({}), set } },
  runtime: { sendMessage: async () => null },
  commands: { getAll: async () => [] },
  tabs: { create: async () => undefined },
});

const groups = () => screen.getByRole("switch", { name: "Group tabs by branch" });

beforeEach(() => {
  set.mockClear();
});

describe("an options switch", () => {
  for (const ok of [true, false]) {
    it(`turns off at once, then ${ok ? "stays off once stored" : "turns back on when the store refuses"}`, async () => {
      render(() => <Options />);
      await waitFor(() => expect(groups().getAttribute("aria-checked")).toBe("true"));

      fireEvent.click(groups());
      await waitFor(() => expect(groups().getAttribute("aria-checked")).toBe("false"));
      expect(set).toHaveBeenCalledWith({ groups: false });

      answer(ok);
      await waitFor(() => expect(groups().getAttribute("aria-checked")).toBe(ok ? "false" : "true"));
      expect(screen.queryByRole("alert")?.textContent ?? null).toBe(ok ? null : "Not saved: Error: quota");
    });
  }
});

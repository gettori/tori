import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";

const { pair } = vi.hoisted(() => ({
  pair: vi.fn(async () => ({ url: "ws://100.64.0.1:7878", credential: "c", id: "d1", name: "Phone" })),
}));

vi.mock("./remote", async (actual) => ({ ...(await actual<typeof import("./remote")>()), pair }));

import Pair from "./Pair";

describe("a pairing link", () => {
  it("fills the form and pairs only on a tap", async () => {
    render(() => <Pair notice={null} link={{ url: "ws://100.64.0.1:7878", code: "ABCD2345" }} onPaired={() => {}} />);
    const tap = await screen.findByRole("button", { name: "Pair with 100.64.0.1:7878" });
    expect(pair).not.toHaveBeenCalled();

    fireEvent.click(tap);
    await waitFor(() => expect(pair).toHaveBeenCalledWith("ws://100.64.0.1:7878", "ABCD2345", "Phone"));
  });
});

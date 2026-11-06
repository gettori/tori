import { describe, it, expect } from "vite-plus/test";
import { PROTOCOL, RpcError, STORE_UNREADABLE_CODE, UNAUTHORIZED_CODE, forgetsCredential, updateFrom } from "./remote";

describe("updateFrom", () => {
  it("names the side the Mac says is behind", () => {
    expect(updateFrom({ kind: "device", update: "app" })).toBe("app");
    expect(updateFrom({ kind: "device", update: null })).toBe(null);
    expect(updateFrom({ kind: "device", update: "tori" })).toBe("tori");
  });

  it("reads a Tori that answers no update as protocol 0", () => {
    expect(updateFrom({ kind: "device" }, 0)).toBe(null);
    expect(updateFrom({ kind: "device" }, 1)).toBe("tori");
    expect(updateFrom(null, PROTOCOL)).toBe("tori");
  });
});

describe("forgetsCredential", () => {
  it("keeps the credential when the Mac cannot read its device store", () => {
    expect(forgetsCredential(new RpcError("device store unreadable", STORE_UNREADABLE_CODE))).toBe(false);
    expect(forgetsCredential(new RpcError("wrong token", UNAUTHORIZED_CODE))).toBe(true);
  });
});

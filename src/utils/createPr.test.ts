import { describe, it, expect } from "vite-plus/test";
import { apiCanServe, composeDraftRequest, prPath, submitBlockedReason } from "./createPr";
import type { AuthState } from "./forgeTypes";
import type { KnownHosts } from "./prUrl";

const SIGNED_IN: AuthState = { kind: "signedIn", login: "skarif2" };
const SIGNED_OUT: AuthState = { kind: "signedOut" };
const SUSPECT: AuthState = { kind: "suspect", login: "skarif2" };

const GH = "git@github.com:skarif2/tori.git";
const HOSTS: KnownHosts = new Map([["github.com", { provider: "github", baseUrl: "https://github.com" }]]);

describe("prPath", () => {
  it("opens the in-app form only for a signed-in, enabled GitHub remote", () => {
    expect(prPath(GH, HOSTS, SIGNED_IN, true)).toBe("form");
  });

  it("falls back to compare for every reason the API cannot serve", () => {
    // None of these is an error state. Opening a PR through the provider's own
    // page works without an account, which is why signing out costs the user
    // the in-app form and nothing else.
    expect(prPath(GH, HOSTS, SIGNED_OUT, true)).toBe("compare");
    expect(prPath(GH, HOSTS, SUSPECT, true)).toBe("compare");
    expect(prPath(GH, HOSTS, SIGNED_IN, false)).toBe("compare");
    expect(prPath("git@gitlab.com:skarif2/tori.git", HOSTS, SIGNED_IN, true)).toBe("compare");
    expect(prPath("git@bitbucket.org:skarif2/tori.git", HOSTS, SIGNED_IN, true)).toBe("compare");
  });

  it("refuses only when there is no usable origin at all", () => {
    expect(prPath(null, HOSTS, SIGNED_IN, true)).toBe("none");
    expect(prPath("", HOSTS, SIGNED_IN, true)).toBe("none");
    expect(prPath("git@example.com:skarif2/tori.git", HOSTS, SIGNED_IN, true)).toBe("none");
  });

  it("opens the form on a self-hosted host only once it has an account", () => {
    // Without one, prUrl's name guess still gives GHE a working compare URL, but
    // a form would submit and come back `unsupportedRemote` after the user had
    // typed a title and body.
    const ghe = "git@github.mycorp.com:skarif2/tori.git";
    expect(apiCanServe(ghe, HOSTS)).toBe(false);
    expect(prPath(ghe, HOSTS, SIGNED_IN, true)).toBe("compare");
    const registered: KnownHosts = new Map([
      ...HOSTS,
      ["github.mycorp.com", { provider: "github", baseUrl: "https://github.mycorp.com" }],
    ]);
    expect(prPath(ghe, registered, SIGNED_IN, true)).toBe("form");
  });

  it("accepts the https and ssh spellings of the same remote", () => {
    for (const origin of [
      "https://github.com/skarif2/tori.git",
      "https://github.com/skarif2/tori",
      "git@github.com:skarif2/tori.git",
      "ssh://git@github.com/skarif2/tori.git",
    ]) {
      expect(prPath(origin, HOSTS, SIGNED_IN, true), origin).toBe("form");
    }
  });
});

describe("submitBlockedReason", () => {
  const ok = { title: "Add a thing", base: "main", head: "wave-3", busy: false };

  it("allows a complete form", () => {
    expect(submitBlockedReason(ok)).toBeNull();
  });

  it("names what is missing rather than just disabling the button", () => {
    expect(submitBlockedReason({ ...ok, title: "   " })).toBe("A title is required");
    expect(submitBlockedReason({ ...ok, head: "" })).toBe("No branch to open a PR from");
    expect(submitBlockedReason({ ...ok, base: "" })).toBe("No base branch");
    expect(submitBlockedReason({ ...ok, busy: true })).toBe("Opening…");
  });

  it("catches a base that equals the branch before the server does", () => {
    // GitHub answers this with a 422 whose message is easy to miss, and no
    // amount of retrying fixes it: the user has to change the base.
    expect(submitBlockedReason({ ...ok, base: "wave-3" })).toBe("The base and the branch are the same");
    expect(submitBlockedReason({ ...ok, base: " wave-3 " })).toBe("The base and the branch are the same");
  });
});

describe("composeDraftRequest", () => {
  it("names the branch, the base, and the files", () => {
    const text = composeDraftRequest("wave-3", "main", ["src/a.ts", "src/b.ts"]);
    expect(text).toContain("wave-3");
    expect(text).toContain("main");
    expect(text).toContain("src/a.ts, src/b.ts");
  });

  it("still asks for a draft when it has no file list", () => {
    // An empty list must not produce a dangling colon, and must not stop the
    // request: the agent can read the diff itself.
    const text = composeDraftRequest("wave-3", "main", []);
    expect(text).toBe("Draft a pull request title and body for wave-3 against main");
  });
});

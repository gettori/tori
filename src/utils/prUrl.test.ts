import { describe, it, expect } from "vitest";
import { parseOrigin, comparePrUrl } from "./prUrl";

describe("parseOrigin", () => {
  it("parses an https GitHub origin", () => {
    expect(parseOrigin("https://github.com/acme/widgets.git")).toEqual({
      provider: "github",
      host: "github.com",
      owner: "acme",
      repo: "widgets",
    });
  });

  it("parses an https origin without a trailing .git", () => {
    expect(parseOrigin("https://github.com/acme/widgets")).toEqual({
      provider: "github",
      host: "github.com",
      owner: "acme",
      repo: "widgets",
    });
  });

  it("parses a scp-like ssh GitHub origin", () => {
    expect(parseOrigin("git@github.com:acme/widgets.git")).toEqual({
      provider: "github",
      host: "github.com",
      owner: "acme",
      repo: "widgets",
    });
  });

  it("parses an ssh:// GitHub origin", () => {
    expect(parseOrigin("ssh://git@github.com/acme/widgets.git")).toEqual({
      provider: "github",
      host: "github.com",
      owner: "acme",
      repo: "widgets",
    });
  });

  it("parses an https GitLab origin with a nested subgroup", () => {
    expect(parseOrigin("https://gitlab.com/acme/team/widgets.git")).toEqual({
      provider: "gitlab",
      host: "gitlab.com",
      owner: "acme/team",
      repo: "widgets",
    });
  });

  it("parses a scp-like ssh GitLab origin", () => {
    expect(parseOrigin("git@gitlab.com:acme/widgets.git")).toEqual({
      provider: "gitlab",
      host: "gitlab.com",
      owner: "acme",
      repo: "widgets",
    });
  });

  it("parses an https Bitbucket origin", () => {
    expect(parseOrigin("https://bitbucket.org/acme/widgets.git")).toEqual({
      provider: "bitbucket",
      host: "bitbucket.org",
      owner: "acme",
      repo: "widgets",
    });
  });

  it("parses a scp-like ssh Bitbucket origin", () => {
    expect(parseOrigin("git@bitbucket.org:acme/widgets.git")).toEqual({
      provider: "bitbucket",
      host: "bitbucket.org",
      owner: "acme",
      repo: "widgets",
    });
  });

  it("resolves a self-hosted host by substring (GitHub Enterprise)", () => {
    expect(parseOrigin("https://github.acme.internal/acme/widgets.git")?.host).toBe("github.acme.internal");
  });

  it("returns null for an unrecognized provider", () => {
    expect(parseOrigin("https://example.com/acme/widgets.git")).toBeNull();
  });

  it("returns null for an unparseable URL", () => {
    expect(parseOrigin("not a url")).toBeNull();
  });
});

describe("comparePrUrl", () => {
  it("builds a GitHub compare URL", () => {
    expect(comparePrUrl("https://github.com/acme/widgets.git", "main", "feature/x")).toBe(
      "https://github.com/acme/widgets/compare/main...feature%2Fx?expand=1",
    );
  });

  it("builds a GitHub compare URL from an ssh origin", () => {
    expect(comparePrUrl("git@github.com:acme/widgets.git", "main", "feature")).toBe(
      "https://github.com/acme/widgets/compare/main...feature?expand=1",
    );
  });

  it("builds a GitLab merge-request URL", () => {
    expect(comparePrUrl("https://gitlab.com/acme/widgets.git", "main", "feature")).toBe(
      "https://gitlab.com/acme/widgets/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature&merge_request%5Btarget_branch%5D=main",
    );
  });

  it("builds a GitLab merge-request URL from an ssh origin", () => {
    expect(comparePrUrl("git@gitlab.com:acme/widgets.git", "main", "feature")).toBe(
      "https://gitlab.com/acme/widgets/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature&merge_request%5Btarget_branch%5D=main",
    );
  });

  it("builds a Bitbucket pull-request URL", () => {
    expect(comparePrUrl("https://bitbucket.org/acme/widgets.git", "main", "feature")).toBe(
      "https://bitbucket.org/acme/widgets/pull-requests/new?source=feature&dest=main",
    );
  });

  it("builds a Bitbucket pull-request URL from an ssh origin", () => {
    expect(comparePrUrl("git@bitbucket.org:acme/widgets.git", "main", "feature")).toBe(
      "https://bitbucket.org/acme/widgets/pull-requests/new?source=feature&dest=main",
    );
  });

  it("returns null when the origin isn't a recognized provider", () => {
    expect(comparePrUrl("https://example.com/acme/widgets.git", "main", "feature")).toBeNull();
  });
});

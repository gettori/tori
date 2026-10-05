import { describe, it, expect } from "vite-plus/test";
import { fileSkip, fileLabel } from "./prFiles";
import type { PrFile } from "./forgeTypes";

const file = (over: Partial<PrFile> = {}): PrFile => ({
  path: "src/utils/forgeChip.ts",
  previousPath: null,
  status: "modified",
  additions: 4,
  deletions: 1,
  patch: "@@ -1,1 +1,1 @@\n-a\n+b",
  ...over,
});

describe("fileSkip", () => {
  it("renders the diff whenever there is one", () => {
    expect(fileSkip(file())).toBeNull();
  });

  it("tells a withheld patch apart from an absent one", () => {
    // The distinction the whole module exists for. Both arrive as `patch: null`
    // and only one of them means something is missing; rendering "no changes to
    // show" over a 4,000-line file is the failure that reads as a working diff.
    expect(fileSkip(file({ patch: null, additions: 3_000, deletions: 900 }))).toBe("tooLarge");
    expect(fileSkip(file({ patch: null, additions: 0, deletions: 0 }))).toBe("noText");
  });

  it("reads a pure rename as moved, not as an empty file", () => {
    // A rename with no content change is complete and correct at zero lines.
    // Calling it binary would send the reader hunting for a diff that does not
    // exist, and calling it too large would be simply false.
    expect(
      fileSkip(
        file({ status: "renamed", previousPath: "src/panels/chip.ts", patch: null, additions: 0, deletions: 0 }),
      ),
    ).toBe("moved");
  });

  it("puts size before the move when a rename is also too big", () => {
    // A renamed file whose patch was withheld has both facts true. The one worth
    // saying is the one where content is missing.
    expect(
      fileSkip(file({ status: "renamed", previousPath: "old.ts", patch: null, additions: 900, deletions: 12 })),
    ).toBe("tooLarge");
  });

  it("treats an empty patch as no patch rather than as an empty diff", () => {
    // Not a shape GitHub sends, but the alternative is a row that opens onto
    // nothing with no sentence saying why.
    expect(fileSkip(file({ patch: "", additions: 0, deletions: 0 }))).toBe("noText");
    expect(fileSkip(file({ patch: "  \n ", additions: 0, deletions: 0 }))).toBe("noText");
  });
});

describe("fileLabel", () => {
  it("says both halves of a rename", () => {
    // "src/to.ts" on its own is indistinguishable from a brand-new file.
    expect(fileLabel(file({ previousPath: "src/from.ts", path: "src/to.ts" }))).toBe("src/from.ts → src/to.ts");
    expect(fileLabel(file({ path: "src/to.ts" }))).toBe("src/to.ts");
  });
});

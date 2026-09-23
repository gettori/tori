---
summary: createLinkedBranch creates a new ref at a commit already on GitHub; it cannot link an existing branch, so link first
status: current
updated: 2026-09-24
source: "gettori/tori#202 on branch orchestrator; commits f8a61936, 83aa08f4, 982c9bed; src-tauri/src/issues/github.rs link_branch; schema introspected 2026-09-24"
---

# createLinkedBranch only makes a new ref

Do not create the local branch first and link it later: `createLinkedBranch(issueId, oid, name)` makes a **new** ref on GitHub at a commit GitHub already has, and there is no mutation that links a branch that already exists. Why: the Development panel link is created with the ref, so the order has to be link, fetch, then track `origin/<name>`. Check `issue.linkedBranches` and the ref first, so a retry reports `AlreadyLinked` or `Unlinked` rather than failing. `Issue` also has no readable suggested branch name, so the name is computed (`<number>-<slug>`).

## Related

- [[component_issue_source]]

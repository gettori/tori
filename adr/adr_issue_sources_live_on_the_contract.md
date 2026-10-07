---
summary: issue sources are repo plus criteria on the contract, replace the origin, and never close running work
status: current
updated: 2026-10-08
source: gettori/tickets#31 on branch phase-1-block-1, plan "Issue sources per project, and the autopilot on Tori's own repo"; commits e7d4df6f, 8646bb90; src-tauri/src/issues/mod.rs (IssueQuery, canonical_key); src-tauri/src/autopilot.rs (plan_pickup)
---

# Issue sources live on the contract

## Context

Pickup read only the issues assigned to you in the project's own origin. Tori's own work items live in a separate repo, gettori/tickets, which can also hold other projects' issues, so the autopilot could not run on Tori itself. A source also has to say which issues there belong to this project.

## Decision

- A project's contract carries `issues: Vec<IssueQuery>`: a repo plus labels (all of), exclude labels, milestone, assignee (`@me` by default, `any`, or a login) and raw `extra` qualifiers. It is set through `autopilot.project.set`, `tori autopilot project --issues` and Settings > Autopilot > Projects, all through one validation.
- An empty list keeps the old behaviour. Once set, sources replace the origin's assigned list, so listing the origin is explicit. Review requests always come from the origin.
- One canonical key: bare `N` in the project's own repo, `owner/name#N` elsewhere, used by search rows, `issues.get`, item updates and the unit record.
- Pickup closes an item that left every list only while it is `proposed` or `queued`; running or waiting work gets a note and the autopilot asks. Nothing closes unless every source answered under the cap.
- A list's first tick only proposes, keyed by its search string through `Item.picked_from`, so a new or edited source never starts a backlog.
- A repo-qualified issue another project holds open is left to that project.

## Alternatives rejected

- **A config file in the repository.** Overlaps #49, the trust-gated shareable project config, and would make a cloned repo pick work for whoever runs it.
- **Raw search strings only.** GitHub-only and nothing to validate; structured fields carry to Linear later (#59), with `extra` for what they miss.
- **Structured fields only.** Misses the odd query, such as a sort or a type.
- **Tracking which source made each item, and closing by that source.** More state, and an item would still close mid-run on an unassignment; `picked_from` exists only for the first-tick rule.
- **Comparing issues by display label.** A URL key drops its repo there, so a tickets issue and the origin's issue of the same number read as one.

## Consequences

- Editing or removing a source can close only work that has not started.
- An origin item that was `proposed` or `queued` closes as gone upstream on the first tick after sources are set, unless a source lists it too.
- A bare key is relative to the project's origin, so two projects sharing one origin are not deduplicated against each other.

## Related

- [[component_issue_source]]: `IssueQuery`, canonical keys, cross-repo `get` and `link_branch`
- [[component_autopilot_store]]: `plan_pickup` and the contract
- [[adr_assigned_pickup_rides_the_forge_poll_tick]]: where the ticks come from
- [[gotcha_an_assigned_list_at_the_search_cap_proves_nothing_missing]]: why a capped list closes nothing

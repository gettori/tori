import { describe, expect, it } from "vite-plus/test";
import {
  activityOf,
  applyItem,
  decisionOf,
  inFlightRows,
  queuedItems,
  ruleCards,
  workerCards,
  type ItemRow,
} from "./autopilotRows";
import type { SocketAsk } from "./socketAsks";

const row = (over: Partial<ItemRow>): ItemRow => ({
  id: "i1",
  kind: "ship",
  source: { type: "issue", key: "12", project: "/code/tori" },
  project: "/code/tori",
  state: "running",
  created: 1,
  updated: 1,
  ...over,
});

describe("fix loop marks", () => {
  const pr = "https://github.com/o/r/pull/7";
  const three = () => 3;

  it("counts fix pushes against the project's attempts and names who stopped it", () => {
    const pushed = row({ pr_url: pr, note: "Fixing lint", fix_pushes: [{ sha: "a", at: 1 }] });
    expect(inFlightRows([pushed], three)[0].doing).toBe("Fixing lint, fix 1/3");
    expect(workerCards([{ ...pushed, fix_stopped: "ana" }], three)[0].doing).toBe(
      "Fixing lint, fix 1/3, stopped by @ana",
    );
  });

  it("marks nothing where the loop is off, before a pull request, or on a review", () => {
    expect(inFlightRows([row({ pr_url: pr })])[0].doing).toBe("Running");
    expect(inFlightRows([row({})], three)[0].doing).toBe("Running");
    expect(inFlightRows([row({ pr_url: pr, kind: "review" })], three)[0].doing).toBe("Running");
  });
});

describe("item titles", () => {
  it("shows the autopilot's title and the contract on the card", () => {
    const [card] = workerCards([row({ title: "Fix the login redirect", contract: "Build: the redirect." })]);
    expect(card.title).toBe("Fix the login redirect");
    expect(card.contract).toBe("Build: the redirect.");
  });

  it("falls back to the kind and project when there is no title", () => {
    expect(workerCards([row({ title: null })])[0].title).toBe("Ship in tori");
    expect(queuedItems([row({ state: "queued", kind: "review" })])[0].title).toBe("Review in tori");
  });

  it("lists proposed items after the queue, marked and after nothing", () => {
    const rows = queuedItems([
      row({ id: "p", state: "proposed", created: 1 }),
      row({ id: "q", state: "queued", created: 2 }),
    ]);
    expect(rows.map((r) => [r.ticket.label, r.proposed ?? false, r.after])).toEqual([
      ["#12", false, undefined],
      ["#12", true, undefined],
    ]);
  });
});

const n = (x: number) => `#${x}`;
const reference = (key: number, project: string) => ({
  label: n(key),
  url: `https://github.com/o/${project}/issues/${key}`,
  place: ["personal", project, "y-test"],
  target: { folder: `/r/personal/${project}/wt`, session: `s-${project}` },
  markdown: "",
});

describe("ticket references", () => {
  const tori = row({ id: "a", reference: reference(212, "tori") });
  const initech = row({ id: "b", project: "/code/initech", reference: reference(212, "initech") });

  it("tells two items with the same number apart by where they are", () => {
    const [one, two] = workerCards([tori, initech]).map((c) => c.ticket);
    expect([one.label, two.label]).toEqual([n(212), n(212)]);
    expect(one.target).not.toEqual(two.target);
    expect(two.place).toEqual(["personal", "initech", "y-test"]);
  });

  it("reads an item without a reference by its number alone", () => {
    expect(workerCards([row({ source: { type: "issue", key: n(12), project: "/code/tori" } })])[0].ticket).toEqual({
      label: n(12),
      place: [],
    });
    expect(workerCards([row({ source: { type: "issue", key: "ENG-9", project: "/code/tori" } })])[0].ticket.label).toBe(
      "ENG-9",
    );
  });

  it("reads a rule's item by its pull request number", () => {
    const ruled = row({ source: { type: "rule", pr: 7, repo: "o/r", event: "changes_requested" } });
    expect(workerCards([ruled])[0].ticket).toEqual({ label: n(7), place: [] });
  });

  it("names a logged item by the current row's reference", () => {
    const logged = { ts: 0, item: row({ id: "a", state: "done" }) };
    const line = activityOf(logged, [tori]);
    expect(line?.ticket?.place).toEqual(["personal", "tori", "y-test"]);
    expect(line?.text).toBe("done");
  });

  it("keeps the derived fields a live change does not carry", () => {
    const seen = row({ id: "a", session_live: true, worktree_gone: false, reference: reference(212, "tori") });
    const [after] = applyItem([seen], row({ id: "a", note: "tests pass", reference: reference(212, "tori") }));
    expect([after.note, after.session_live, after.worktree_gone, after.reference?.label]).toEqual([
      "tests pass",
      true,
      false,
      n(212),
    ]);
  });

  it("puts the issue on a decision card and its pull request beside it", () => {
    const shipped = row({
      id: "a",
      reference: {
        ...reference(212, "tori"),
        pr: { label: `PR ${n(230)}`, url: "https://github.com/o/tori/pull/230" },
      },
    });
    const ask = {
      id: "q",
      session: "s",
      question: "Merge it?",
      item: "a",
      approval: { action: "pr.merge", number: 230 },
    } as unknown as SocketAsk;
    const card = decisionOf(ask, [shipped], [], () => "");
    expect([card.ticket?.label, card.refKind, card.pr?.label]).toEqual([n(212), "issue", `PR ${n(230)}`]);
    const bare = decisionOf({ ...ask, item: undefined } as SocketAsk, [], [], () => "");
    expect([bare.ticket?.label, bare.refKind]).toEqual([n(230), "pr"]);
  });
});

describe("pull request rules", () => {
  it("names the project, its events and how much of the hour it used", () => {
    const [card] = ruleCards([
      {
        project: "/code/tori",
        on: ["changes_requested", "conflicting"],
        max_per_hour: 3,
        fired_this_hour: 1,
        paused: false,
      },
    ]);
    expect(card).toEqual({
      project: "/code/tori",
      name: "tori",
      on: "on changes requested, a conflict",
      fired: "1 of 3 this hour",
      paused: false,
    });
  });
});

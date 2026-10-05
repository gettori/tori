import { describe, it, expect } from "vite-plus/test";
import { createQueue, type Reply, type Request } from "./highlightQueue";

function rig() {
  const posted: Request[] = [];
  const answered: [Request, Reply][] = [];
  const queue = createQueue((req) => posted.push(req));
  const ask = (slot: string, code: string) =>
    queue.request(slot, code, "ts", "html", (req, reply) => answered.push([req, reply]));
  return { posted, answered, queue, ask };
}

describe("the syntax worker queue", () => {
  it("keeps one request in flight per block and sends only the newest waiting one", () => {
    const { posted, answered, queue, ask } = rig();
    ask("a", "c");
    ask("a", "co");
    ask("a", "con");
    expect(posted.map((r) => r.code)).toEqual(["c"]);

    queue.receive({ id: posted[0].id, value: "<c>" });
    expect(posted.map((r) => r.code)).toEqual(["c", "con"]);
    expect(answered.map(([req]) => req.code)).toEqual(["c"]);
  });

  it("does not resend what is already in flight or waiting", () => {
    const { posted, ask } = rig();
    ask("a", "x");
    ask("a", "x");
    ask("a", "y");
    ask("a", "y");
    expect(posted).toHaveLength(1);
  });

  it("answers nobody for a block that is gone, and ignores a reply it never asked for", () => {
    const { posted, answered, queue, ask } = rig();
    ask("a", "x");
    queue.cancel("a");
    queue.receive({ id: posted[0].id, value: "<x>" });
    queue.receive({ id: 999, value: "<y>" });
    expect(answered).toEqual([]);
  });

  // A reply that arrives after a newer request went out is still delivered
  // with the request it answers, so the reader can tell it is older.
  it("hands a late reply over with the request it belongs to", () => {
    const { posted, answered, queue, ask } = rig();
    ask("a", "old");
    ask("a", "newer");
    queue.receive({ id: posted[0].id, value: "<old>" });
    expect(answered[0][0].code).toBe("old");
    queue.receive({ id: posted[1].id, value: "<newer>" });
    expect(answered.map(([req]) => req.code)).toEqual(["old", "newer"]);
  });

  it("keeps blocks apart", () => {
    const { posted, ask } = rig();
    ask("a", "x");
    ask("b", "x");
    expect(posted).toHaveLength(2);
  });
});

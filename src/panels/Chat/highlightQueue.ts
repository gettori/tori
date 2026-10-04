// Traffic between chat code blocks and the syntax worker, kept free of Worker
// so a fake port can drive it. A slot (one block) has one request in flight and
// at most one waiting, and a newer request replaces the waiting one.

export type Form = "html" | "lines";
export type Answer = string | string[];

export type Request = { id: number; code: string; lang: string; form: Form };

// `none`: the language has no grammar. `error`: loading or running it failed.
export type Reply = { id: number; value?: Answer; none?: true; error?: string; ms?: number };

export type Done = (req: Request, reply: Reply) => void;

type Slot = { inFlight: Request; waiting?: { req: Request; done: Done } };

export function createQueue(post: (req: Request) => void) {
  let nextId = 0;
  const slots = new Map<string, Slot>();
  const pending = new Map<number, { slot: string; req: Request; done: Done }>();

  const send = (slot: string, req: Request, done: Done) => {
    pending.set(req.id, { slot, req, done });
    slots.set(slot, { inFlight: req });
    post(req);
  };

  const same = (a: Request, code: string, lang: string, form: Form) =>
    a.code === code && a.lang === lang && a.form === form;

  return {
    request(slot: string, code: string, lang: string, form: Form, done: Done): void {
      const busy = slots.get(slot);
      if (busy && (same(busy.inFlight, code, lang, form) || (busy.waiting && same(busy.waiting.req, code, lang, form)))) {
        return;
      }
      const req = { id: ++nextId, code, lang, form };
      if (busy) busy.waiting = { req, done };
      else send(slot, req, done);
    },

    /** The block is gone: whatever it asked for is answered to nobody. */
    cancel(slot: string): void {
      const busy = slots.get(slot);
      if (busy) pending.delete(busy.inFlight.id);
      slots.delete(slot);
    },

    receive(reply: Reply): void {
      const entry = pending.get(reply.id);
      if (!entry) return;
      pending.delete(reply.id);
      const busy = slots.get(entry.slot);
      slots.delete(entry.slot);
      // Delivered even when a newer request is waiting: its text is a prefix
      // of what the block shows now, so its colours are still worth painting.
      entry.done(entry.req, reply);
      if (busy?.waiting) send(entry.slot, busy.waiting.req, busy.waiting.done);
    },
  };
}

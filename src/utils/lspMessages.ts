// A server's `window/showMessageRequest`, queued for the one dialog that asks
// it. Here rather than on the client so the dialog can sit in the app shell.
import { createSignal } from "solid-js";

export type MessageAction = { title: string };

export type MessageRequest = {
  // The session that asked, so its questions go when it does.
  owner: string;
  server: string;
  message: string;
  actions: MessageAction[];
  answer: (action: MessageAction | null) => void;
};

const [queue, setQueue] = createSignal<readonly MessageRequest[]>([]);

export const pendingMessageRequest = () => queue()[0];

export function askServerQuestion(owner: string, server: string, params: unknown): Promise<MessageAction | null> {
  const { message, actions } = (params ?? {}) as { message?: string; actions?: MessageAction[] };
  return new Promise((resolve) => {
    const request: MessageRequest = {
      owner,
      server,
      message: message ?? "",
      actions: actions ?? [],
      answer: (action) => {
        setQueue((q) => q.filter((r) => r !== request));
        resolve(action);
      },
    };
    setQueue((q) => [...q, request]);
  });
}

export function dropServerQuestions(owner?: string): void {
  for (const r of queue()) if (owner === undefined || r.owner === owner) r.answer(null);
}

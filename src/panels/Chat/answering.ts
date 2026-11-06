import { createSignal } from "solid-js";
import { emitWith, TOAST, type ToastEvent } from "../../utils/events";
import { answerAsk } from "../../utils/socketAsks";

export function answering(id: () => string) {
  const [sending, setSending] = createSignal(false);
  const send = (answer: string) => {
    if (!answer.trim() || sending()) return;
    setSending(true);
    answerAsk(id(), answer.trim()).catch((e) => {
      setSending(false);
      emitWith<ToastEvent>(TOAST, { message: `The answer did not reach the asker: ${String(e)}`, kind: "error" });
    });
  };
  return { sending, send };
}

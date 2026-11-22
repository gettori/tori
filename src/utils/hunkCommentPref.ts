// Whether a hunk comment goes out the moment it is written instead of being
// held for one batched send. Off by default: a review is several comments, and
// sending each costs a trip per hunk.
import { createLiveSignal } from "../lib/liveState";

const SEND_NOW_KEY = "tori.hunkComments.sendNow";

const [sendHunkCommentsNow, setSendNowSignal] = createLiveSignal(localStorage.getItem(SEND_NOW_KEY) === "1");

export { sendHunkCommentsNow };

export function writeSendHunkCommentsNow(on: boolean): void {
  setSendNowSignal(on);
  localStorage.setItem(SEND_NOW_KEY, on ? "1" : "0");
}

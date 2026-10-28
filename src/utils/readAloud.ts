import { on, READ_LAST_REPLY, READ_SELECTION, STOP_READING } from "./events";
import { heldSelection } from "../components/SelectionToolbar/SelectionToolbar";
import { frontReply, readSelection, stop } from "./speech";

let started = false;

export function watchReadAloud() {
  if (started) return;
  started = true;
  on(READ_SELECTION, () => void readSelection(heldSelection()));
  on(READ_LAST_REPLY, () => frontReply()?.());
  on(STOP_READING, () => void stop());
}

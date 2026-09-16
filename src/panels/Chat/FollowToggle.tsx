import { Bot, BotOff } from "lucide-solid";
import { PillToggle } from "./Picker";
import { followEdits, setFollowEdits } from "../../utils/followPref";

/**
 * Follow live edits, on the composer's bar.
 *
 * **Tori's own lever, not the agent's**, which is the whole of why it takes no
 * props. Everything else on that bar is a session's: the model, the mode and
 * whatever the agent published, each of them addressed to a child process and
 * disabled when there is no turn to be had. This one is a setting of the
 * editor's, so it is the same switch in every chat, it is never pending on an
 * acknowledgement, and it stays live in a chat that has ended, been refused, or
 * has no session behind it at all.
 *
 * Last on the bar for the same reason: it is the one control there the agent has
 * no say in.
 */
export default function FollowToggle() {
  return (
    <PillToggle
      icon={Bot}
      iconOff={BotOff}
      on={followEdits()}
      ariaLabel="Follow live edits"
      tooltip={
        followEdits()
          ? "Following live edits: auto-opening the most-recently-changed file as sessions edit. Click to stop."
          : "Follow live edits: auto-open the most-recently-changed file as sessions edit them (skips git, build output, and your own saves)."
      }
      onChange={setFollowEdits}
    />
  );
}

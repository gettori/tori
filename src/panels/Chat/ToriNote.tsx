import { Show, createSignal } from "solid-js";
import { Info } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import Tooltip from "../../components/Tooltip/Tooltip";
import { type ToriNote } from "../../utils/toriNote";
import { findSession } from "../../utils/sessionStore";
// The tray's template mark: one colour, so it can take the text's.
import toriMark from "../../../src-tauri/icons/tray.png";
import styles from "./Chat.module.css";

// A wake line is `item <id>: <what>, session <sid>` or `session <sid>: <what>`.
const wakeWhat = (line: string) => /^item [^:]+: (.+), session \S+$/.exec(line)?.[1] ?? /^session [^:]+: (.+)$/.exec(line)?.[1];

export function toriLabel(note: ToriNote, sessionName: (id: string) => string | null): string {
  switch (note.kind) {
    case "brief":
      return "Tori started the autopilot with its brief";
    case "resume":
      return "Tori resumed the autopilot";
    case "compacted":
      return "Tori gave the autopilot its brief again after compacting";
    case "wake": {
      const whats = note.body.split("\n").map(wakeWhat).filter((w): w is string => !!w);
      return whats.length ? `Tori: a worker reports ${whats.join("; ")}` : "Tori woke the autopilot";
    }
    case "steer":
      return `From ${(note.from && sessionName(note.from)) || "another session"}`;
    default:
      return "From Tori";
  }
}

const nameOf = (id: string) => {
  const meta = findSession(id)?.session;
  return meta?.name || meta?.title || null;
};

export default function ToriNoteRow(props: { note: ToriNote }) {
  const [open, setOpen] = createSignal(false);
  return (
    <div class={styles.toriRow}>
      <div class={styles.toriLine}>
        <span class={styles.toriMark} style={{ "--mark": `url(${toriMark})` }} aria-hidden="true" />
        <span>{toriLabel(props.note, nameOf)}</span>
        <Tooltip
          as="button"
          type="button"
          class={styles.toriInfo}
          label={open() ? "Hide what Tori sent" : "Show what Tori sent"}
          aria-label="What Tori sent"
          aria-expanded={open()}
          onClick={() => setOpen(!open())}
        >
          <Icon icon={Info} />
        </Tooltip>
      </div>
      <Show when={open()}>
        <pre class={styles.toriBody}>{props.note.body}</pre>
      </Show>
    </div>
  );
}

import AutopilotSwitch from "../../../../components/Autopilot/AutopilotSwitch";
import AutopilotView from "../../../../components/Autopilot/AutopilotView";
import { pickScene } from "../../../../components/Autopilot/Horizon";
import type {
  Decision,
  QueuedItem,
  ThreadMessage,
  TicketRef,
  WorkerCard,
} from "../../../../components/Autopilot/autopilot";
import { heroFor } from "../../../../utils/autopilotRows";
import MiniWindow from "./MiniWindow";
import styles from "./Autopilot.module.css";

const ref = (n: number) => `#${n}`;
const ticket = (n: number, project: string, branch: string): TicketRef => ({
  label: ref(n),
  place: ["work", project, branch],
});

// The real cockpit on made up data, with the ship's log left out so the crew
// and the conversation keep a readable size inside the slide.
export default function AutopilotArt() {
  const workers: WorkerCard[] = [
    {
      ticket: ticket(212, "api", "fix/rate-limit"),
      title: "Cap the rate limiter",
      diff: "+24 -3",
      status: "needs",
      log: ["$ pnpm test limiter", "  18 passed", "> waiting on your PR approval"],
      doing: "Needs your approval",
    },
    {
      ticket: ticket(214, "web", "feat/webhooks"),
      title: "Retry failed webhooks",
      diff: "+61 -8",
      status: "working",
      log: ["> edit src/webhooks/retry.ts", "$ pnpm test webhooks"],
      doing: "Running tests",
      progress: 0.6,
    },
  ];
  const queue: QueuedItem[] = [
    {
      ticket: { label: ref(215), place: ["work", "web"] },
      title: "Document webhook retries",
      after: workers[1].ticket,
    },
  ];
  const messages: ThreadMessage[] = [
    { from: "me", text: `work on ${ref(212)} and ${ref(214)}, then ${ref(215)}` },
    {
      from: "autopilot",
      text: `Started two workers: ${ref(212)} in api and ${ref(214)} in web. ${ref(215)} waits for ${ref(214)}, since it documents that change.`,
    },
    {
      from: "autopilot",
      text: `${ref(212)} is done and all 18 limiter tests pass. Opening its PR sends it to GitHub, so I need your approval.`,
    },
  ];
  const decisions: Decision[] = [
    {
      kind: "pr",
      ticket: workers[0].ticket,
      title: "Cap the rate limiter",
      summary: "Open a draft PR from fix/rate-limit into main. 3 files, +24 -3, tests pass.",
      age: "now",
    },
  ];
  return (
    <MiniWindow
      height={470}
      zoom={0.7}
      end={<AutopilotSwitch view="autopilot" state="needs" count={decisions.length} />}
    >
      <div class={styles.cockpit}>
        <AutopilotView
          state="needs"
          workers={workers}
          emptyWorkers=""
          queue={queue}
          messages={messages}
          decisions={decisions}
          focused={0}
          activity={[]}
          shield=""
          hero={heroFor("needs", decisions.length, workers.length, queue.length, 0)}
          scene={pickScene(new Date().getHours())}
        />
      </div>
    </MiniWindow>
  );
}

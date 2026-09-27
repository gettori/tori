import type { JSX } from "solid-js";
import { ArrowUp, ChevronLeft } from "lucide-solid";
import Icon from "../../../../components/Icon/Icon";
import MessageList from "../../../Chat/MessageList";
import type { ChatItem } from "../../../Chat/chatStore";
import BottomBar from "../../../../../mobile/src/BottomBar";
import Pending, { type PendingRow } from "../../../../../mobile/src/Pending";
import Root, { DOT, PhaseMark } from "../../../../../mobile/src/Root";
import type { RemoteClient } from "../../../../../mobile/src/remote";
import { PHASE_LABEL, type SessionRow, type Space, type Unit } from "../../../../../mobile/src/tree";
import mobile from "../../../../../mobile/src/mobile.module.css";
import shell from "../../../../../mobile/src/shell.module.css";
import styles from "./Mobile.module.css";

const QR_SIZE = 25;

// A made up code with the three finder squares, drawn from a fixed seed so it
// looks the same on every run. Nothing scans it.
function qrModules(): [number, number][] {
  const finder = (x: number, y: number) => {
    const at = (ox: number, oy: number) => x >= ox && x < ox + 7 && y >= oy && y < oy + 7;
    const ring = (ox: number, oy: number) => {
      const dx = x - ox;
      const dy = y - oy;
      return dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
    };
    for (const [ox, oy] of [[0, 0], [QR_SIZE - 7, 0], [0, QR_SIZE - 7]]) if (at(ox, oy)) return ring(ox, oy) ? 1 : 0;
    const near = (ox: number, oy: number) => x >= ox - 1 && x <= ox + 7 && y >= oy - 1 && y <= oy + 7;
    return near(0, 0) || near(QR_SIZE - 7, 0) || near(0, QR_SIZE - 7) ? 0 : -1;
  };
  let seed = 7;
  const out: [number, number][] = [];
  for (let y = 0; y < QR_SIZE; y++) {
    for (let x = 0; x < QR_SIZE; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const f = finder(x, y);
      if (f === 1 || (f === -1 && seed % 100 < 47)) out.push([x, y]);
    }
  }
  return out;
}

function PairingCard() {
  const d = qrModules()
    .map(([x, y]) => `M${x} ${y}h1v1h-1z`)
    .join("");
  return (
    <div class={`${styles.card} ${styles.pairCard} ${styles.rise}`}>
      <div class={styles.cardHead}>
        <span class={styles.crewName}>Pair a device</span>
        <span class={styles.stripEnd}>Settings &gt; Remote access</span>
      </div>
      <div class={styles.pairBody}>
        <svg class={styles.qr} viewBox={`-2 -2 ${QR_SIZE + 4} ${QR_SIZE + 4}`} aria-hidden="true">
          <path d={d} fill="currentColor" />
        </svg>
        <kbd class={styles.pairCode}>K7QF-2MXD</kbd>
        <span class={`${styles.mono} ${styles.muted}`}>ws://100.84.12.7:47821</span>
        <span class={styles.muted}>Expires in 4:52</span>
      </div>
      <div class={styles.strip}>
        <span class={styles.muted}>Tailscale</span>
        <span class={`${styles.stripEnd} ${styles.connected}`}>Connected</span>
      </div>
    </div>
  );
}

const noClient = { status: () => "open", request: () => new Promise(() => {}), subscribe: () => () => {} } as unknown as RemoteClient;

function unit(folder: string, branch: string): Unit {
  return { label: branch, folder, branch, kind: "worktree", isCurrent: false };
}

const PHONE_SPACES: Space[] = [
  {
    name: "work",
    path: "~/Projects/work",
    icon: null,
    color: null,
    projects: [
      { name: "api", path: "~/Projects/work/api", units: [unit("~/Projects/work/api/fix", "fix/rate-limit"), unit("~/Projects/work/api/limits", "docs/limits")] },
      { name: "web", path: "~/Projects/work/web", units: [unit("~/Projects/work/web/webhooks", "feat/webhooks"), unit("~/Projects/work/web/main", "main")] },
      { name: "infra", path: "~/Projects/work/infra", units: [unit("~/Projects/work/infra/main", "main")] },
    ],
  },
  { name: "personal", path: "~/Projects/personal", icon: null, color: null, projects: [] },
];

const home = (project: string, folder: string, branch: string) => ({ project: `~/Projects/work/${project}`, folder: `~/Projects/work/${project}/${folder}`, branch });

const PHONE_LIVE: SessionRow[] = [
  { id: "s1", title: "Cap the rate limiter", live: true, dot: "needs", last_active: 0, home: home("api", "fix", "fix/rate-limit") },
  { id: "s2", title: "Limits docs", live: true, dot: "working", last_active: 0, home: home("api", "limits", "docs/limits") },
  { id: "s3", title: "Retry failed webhooks", live: true, dot: "working", last_active: 0, home: home("web", "webhooks", "feat/webhooks") },
];

const PHONE_CHAT: ChatItem[] = [
  { kind: "user", id: "u1", blocks: [{ type: "text", text: "now send the Retry-After header" }], steer: false },
  { kind: "text", id: "t1", turnId: "t", agentId: null, text: "Added `Retry-After` to the 429 response, set from the bucket's reset time, and a test for it. Running the suite now." },
];

const PHONE_PENDING: PendingRow[] = [{ kind: "permission", id: "p1", tool: "Bash", detail: "pnpm test limiter" }];

function Phone(props: { children: JSX.Element; i: number }) {
  return (
    <div class={`${styles.phone} ${styles.rise}`} style={{ "--i": props.i }}>
      <div class={styles.phoneScreen}>
        <div class={styles.statusBar}>
          <span>9:41</span>
          <span class={styles.island} />
        </div>
        <div class={shell.shell}>{props.children}</div>
      </div>
    </div>
  );
}

// The phone app's own screens on made up data. The client never connects, so
// nothing a screen asks the Mac for ever arrives.
export default function MobileArt() {
  return (
    <div class={styles.phones} inert>
      <PairingCard />
      <Phone i={2}>
        <Root
          client={noClient}
          tree={{ spaces: PHONE_SPACES, topics: [] }}
          space={PHONE_SPACES[0]}
          tab="projects"
          live={() => PHONE_LIVE}
          notice={null}
          onProject={() => {}}
          onTopic={() => {}}
          onUnit={() => {}}
          onSession={() => {}}
          onSettings={() => {}}
        />
        <BottomBar
          spaces={PHONE_SPACES}
          space={PHONE_SPACES[0]}
          tab="projects"
          live={() => PHONE_LIVE}
          showWheel
          runner={() => null}
          decisions={() => 0}
          onSpace={() => {}}
          onTopics={() => {}}
          onWheel={() => {}}
        />
      </Phone>
      <Phone i={5}>
        <div class={shell.chat}>
          <header class={shell.chatTop}>
            <span class={shell.circle}>
              <Icon icon={ChevronLeft} size={20} strokeWidth={2} />
            </span>
            <span class={shell.chatTitles}>
              <span class={shell.chatTitle}>Cap the rate limiter</span>
              <span class={shell.stateLine}>
                <PhaseMark phase="needs" />
                {PHASE_LABEL.needs} {DOT} api {"\u203a"} fix/rate-limit
              </span>
            </span>
          </header>
          <div class={mobile.transcript}>
            <MessageList
              items={PHONE_CHAT}
              streaming={false}
              sessionId="intro"
              cwd=""
              modelLabelFor={() => null}
              onSetMode={() => {}}
              onRevertHunk={async () => false}
            />
          </div>
          <Pending client={noClient} session="s1" rows={PHONE_PENDING} onSettled={() => {}} />
          <div class={shell.composer}>
            <span class={shell.composerInput}>Message</span>
            <span class={shell.composerRow}>
              <span class={shell.send}>
                <Icon icon={ArrowUp} size={17} strokeWidth={2.6} />
              </span>
            </span>
          </div>
        </div>
      </Phone>
    </div>
  );
}

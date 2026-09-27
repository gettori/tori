import { For, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import Button from "../../../components/Button/Button";
import FirstRunShell from "../FirstRunShell";
import AgentsArt from "./art/Agents";
import AutopilotArt from "./art/Autopilot";
import FoldersArt from "./art/Folders";
import MobileArt from "./art/Mobile";
import ReviewArt from "./art/Review";
import SessionsArt from "./art/Sessions";
import TerminalArt from "./art/Terminal";
import TopicsArt from "./art/Topics";
import styles from "./Intro.module.css";

export type Slide = { title: string; body: string; art: Component };

export const SLIDES: Slide[] = [
  {
    title: "Every agent session, one window",
    body: "Sessions from every repo sit in one tree, each marked working, needs you, or done, and a parent rolls up its children. You see where to go next without cycling terminal tabs.",
    art: SessionsArt,
  },
  {
    title: "Organised the way your disk already is",
    body: "Base folder, then spaces, then projects, then branches and worktrees. Nothing to import: Tori reads the folders you already have.",
    art: FoldersArt,
  },
  {
    title: "One branch across several repos",
    body: "A Topic is a name and the branch you type, with a worktree for it in each repo you pick. Files, search and changes cover all of them, and a tag on each worktree row takes you back to the Topic.",
    art: TopicsArt,
  },
  {
    title: "Your agents, your hosts, your machine",
    body: "Tori drives the agent CLIs you already have installed. Sign in to GitHub or GitLab to push as your own account. Tori sends no telemetry.",
    art: AgentsArt,
  },
  {
    title: "Undo any turn the agent took",
    body: "Every prompt is checkpointed, so you can diff what a single turn changed or revert the tree to before it. Each session lives in its own chat or terminal tab, and resumes where the agent stopped.",
    art: TerminalArt,
  },
  {
    title: "Review what the agent wrote",
    body: "An editor with LSP, and a Changes panel that stages, commits, pushes and opens the PR. Comment on a hunk and it goes straight back into the session.",
    art: ReviewArt,
  },
  {
    title: "Hand a queue to Autopilot",
    body: "Give it a list of tasks and it starts a worker for each, watches them, and only stops for you when something needs a decision. Off by default: turn it on in Settings > Autopilot.",
    art: AutopilotArt,
  },
  {
    title: "Your sessions on your phone",
    body: "Pair the Tori mobile app with a one-time code, on your own network or over Tailscale. Read along, send or steer a turn, and answer whatever is waiting on you. Off by default: turn it on in Settings > Remote access.",
    art: MobileArt,
  },
];

const pad = (n: number) => String(n).padStart(2, "0");

export default function Intro(props: {
  slide: number;
  onSlide: (index: number) => void;
  onDone: () => void;
}) {
  const last = () => props.slide === SLIDES.length - 1;
  const current = () => SLIDES[props.slide];
  const back = () => props.onSlide(Math.max(0, props.slide - 1));
  const next = () => (last() ? props.onDone() : props.onSlide(props.slide + 1));

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      next();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      back();
    }
  }

  return (
    <FirstRunShell
      title="Tori"
      rail={
        <nav class={styles.index} aria-label="Intro slides">
          <div class={styles.tagline}>A cockpit for the coding agents you already run.</div>
          <For each={SLIDES}>
            {(s, i) => (
              <button
                type="button"
                class={styles.slide}
                classList={{ [styles.slideOn]: i() === props.slide }}
                aria-current={i() === props.slide ? "step" : undefined}
                onClick={() => props.onSlide(i())}
              >
                <span class={styles.slideNum}>{pad(i() + 1)}</span>
                {s.title}
              </button>
            )}
          </For>
        </nav>
      }
      railFooter={
        <button type="button" class={styles.skip} onClick={() => props.onDone()}>
          Skip intro
        </button>
      }
      heading={
        <Show when={current()} keyed>
          {(s) => <span class={styles.enter}>{s.title}.</span>}
        </Show>
      }
      lead={
        <Show when={current()} keyed>
          {(s) => (
            <span class={styles.enter} style={{ "--i": 1 }}>
              {s.body}
            </span>
          )}
        </Show>
      }
      footerLeft={
        <span class={styles.pager}>
          {pad(props.slide + 1)} / {pad(SLIDES.length)}
        </span>
      }
      footerRight={
        <>
          <Button disabled={props.slide === 0} onClick={back}>
            Back
          </Button>
          <Button variant="primary" onClick={next}>
            {last() ? "Set up Tori" : "Next"}
          </Button>
        </>
      }
      onKeyDown={onKeyDown}
    >
      <Dynamic component={current().art} />
    </FirstRunShell>
  );
}

import { For, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import Button from "../../../components/Button/Button";
import FirstRunShell from "../FirstRunShell";
import {
  LayoutIllustration,
  MachineIllustration,
  ReviewIllustration,
  SessionsIllustration,
  TerminalIllustration,
} from "./Illustrations";
import styles from "./Intro.module.css";

export type Slide = { title: string; body: string; art: Component };

export const SLIDES: Slide[] = [
  {
    title: "Every agent session, one window",
    body: "Sessions from every repo sit in one tree, each marked working, needs you, or done, and a parent rolls up its children. You see where to go next without cycling terminal tabs.",
    art: SessionsIllustration,
  },
  {
    title: "Organised the way your disk already is",
    body: "Base folder, then spaces, then projects, then branches and worktrees. Nothing to import: Tori reads the folders you already have. A Topic can span several repos on one branch.",
    art: LayoutIllustration,
  },
  {
    title: "A real terminal for every session",
    body: "Each session gets its own terminal or chat tab. Clicking a row focuses it, or resumes it where the agent stopped. Every prompt is checkpointed, so a single turn can be diffed or reverted.",
    art: TerminalIllustration,
  },
  {
    title: "Review what the agent wrote",
    body: "An editor with LSP, and a Changes panel that stages, commits, pushes and opens the PR. Comment on a hunk and it goes straight back into the session.",
    art: ReviewIllustration,
  },
  {
    title: "Your agents, your hosts, your machine",
    body: "Tori drives the agent CLIs you already have installed. Sign in to GitHub or GitLab to push as your own account. Tori sends no telemetry.",
    art: MachineIllustration,
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
      heading={`${current().title}.`}
      lead={current().body}
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

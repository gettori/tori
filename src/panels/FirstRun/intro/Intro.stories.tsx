import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal } from "solid-js";
import Intro from "./Intro";

function IntroAt(props: { slide: number }) {
  const [slide, setSlide] = createSignal(props.slide);
  return <Intro slide={slide()} onSlide={setSlide} onDone={() => {}} />;
}

// No `component`: each story renders its own slide, and a `component` here
// would make Storybook demand that component's props as args.
const meta = {
  title: "Panels/FirstRun/Intro",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const Sessions: Story = { render: () => <IntroAt slide={0} /> };
export const Layout: Story = { render: () => <IntroAt slide={1} /> };
export const Topics: Story = { render: () => <IntroAt slide={2} /> };
export const Machine: Story = { render: () => <IntroAt slide={3} /> };
export const Terminal: Story = { render: () => <IntroAt slide={4} /> };
export const Review: Story = { render: () => <IntroAt slide={5} /> };
export const Autopilot: Story = { render: () => <IntroAt slide={6} /> };
export const Phone: Story = { render: () => <IntroAt slide={7} /> };

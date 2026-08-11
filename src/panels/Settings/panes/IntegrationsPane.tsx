import { Show } from "solid-js";
import GithubSection from "../GithubSection";
import type { PaneProps } from "../paneKit";

/**
 * The forge account and its kill switch.
 *
 * One section today, and a tab rather than a corner of another one because this
 * is where the next connector lands: an integration is a thing Sway talks to,
 * which is not a property of the editor, the chat or the theme.
 */
export default function IntegrationsPane(props: PaneProps) {
  return (
    <Show when={props.shown("github")}>
      <GithubSection />
    </Show>
  );
}

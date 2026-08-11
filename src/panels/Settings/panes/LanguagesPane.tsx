import { Show } from "solid-js";
import LspSection from "../LspSection";
import DapSection from "../DapSection";
import type { PaneProps } from "../paneKit";

/**
 * Language servers and debug adapters.
 *
 * Two sections whose rows only exist at runtime - one per thing installed - so
 * each carries a single catalogue entry standing for the whole section and is
 * shown or hidden whole. There is nothing here to filter row by row.
 */
export default function LanguagesPane(props: PaneProps) {
  return (
    <>
      <Show when={props.shown("language-servers")}>
        <LspSection />
      </Show>
      <Show when={props.shown("debuggers")}>
        <DapSection />
      </Show>
    </>
  );
}

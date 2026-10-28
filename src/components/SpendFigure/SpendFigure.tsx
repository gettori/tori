import { Show } from "solid-js";
import Tooltip from "../Tooltip/Tooltip";
import { spendView } from "../../utils/spend";
import type { SessionUsage } from "../../utils/chatUsageStore";

export default function SpendFigure(props: {
  usage: SessionUsage | null | undefined;
  what: string;
  before?: string;
  class?: string;
}) {
  return (
    <Show when={spendView(props.usage, props.what)}>
      {(view) => (
        <>
          {props.before}
          <Tooltip<HTMLSpanElement> as="span" class={props.class} label={view().says} data-spend>
            {view().text}
          </Tooltip>
        </>
      )}
    </Show>
  );
}

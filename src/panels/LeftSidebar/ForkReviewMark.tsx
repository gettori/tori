import { Show } from "solid-js";
import { ShieldOff } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import Tooltip from "../../components/Tooltip/Tooltip";
import { FORK_REVIEW, forkReview } from "../../utils/projectTrust";
import rows from "./SidebarRows.module.css";

export default function ForkReviewMark(props: { folder: string }) {
  return (
    <Show when={forkReview(props.folder)}>
      <Tooltip as="span" class={rows.driftMark} label={FORK_REVIEW} aria-label={FORK_REVIEW} tabindex={0}>
        <Icon icon={ShieldOff} />
      </Tooltip>
    </Show>
  );
}

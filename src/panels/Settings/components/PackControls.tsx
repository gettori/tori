import { Show, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { CircleArrowUp, Trash2 } from "lucide-solid";
import Icon from "../../../components/Icon/Icon";
import IconButton from "../../../components/IconButton/IconButton";
import { emitWith, TOAST, type ToastEvent } from "../../../utils/events";
import type { PackKind, Provenance } from "../../../utils/packs";

// No refetch here: every section redraws on its own change event.
export default function PackControls(props: {
  kind: PackKind;
  id: string;
  label: string;
  provenance: Provenance;
  blocked?: () => string | null;
}) {
  const [busy, setBusy] = createSignal(false);
  const run = (command: "packs_update" | "packs_remove") => {
    const reason = props.blocked?.();
    if (reason) {
      emitWith<ToastEvent>(TOAST, { message: reason });
      return;
    }
    setBusy(true);
    invoke(command, { kind: props.kind, id: props.id })
      .catch((e) => emitWith<ToastEvent>(TOAST, { message: `Could not change ${props.id}: ${String(e)}` }))
      .finally(() => setBusy(false));
  };

  return (
    <Show when={props.provenance.source === "catalog"}>
      <Show when={props.provenance.updateAvailable}>
        <IconButton
          size="sm"
          icon={<Icon icon={CircleArrowUp} />}
          tooltip="Update pack"
          aria-label={`Update the ${props.label} pack`}
          disabled={busy()}
          onClick={() => run("packs_update")}
        />
      </Show>
      <IconButton
        size="sm"
        icon={<Icon icon={Trash2} />}
        tooltip="Remove pack"
        aria-label={`Remove the ${props.label} pack`}
        disabled={busy()}
        onClick={() => run("packs_remove")}
      />
    </Show>
  );
}

import { invoke } from "@tauri-apps/api/core";
import { ExternalLink } from "lucide-solid";
import Button from "../../../components/Button/Button";
import Icon from "../../../components/Icon/Icon";
import { emitWith, TOAST, type ToastEvent } from "../../../utils/events";
import type { PackKind } from "../../../utils/packs";

export const packsPage = (kind: PackKind, role?: "secondary") =>
  `https://gettori.app/packs/${kind}/${role ? `?role=${role}` : ""}`;

const NOUN: Record<PackKind, string> = {
  lsp: "LSPs",
  dap: "debuggers",
  formatters: "formatters",
  themes: "themes",
  agents: "agents",
};

export default function BrowsePacks(props: { kind: PackKind; role?: "secondary"; class?: string }) {
  const open = () =>
    void invoke("plugin:opener|open_url", { url: packsPage(props.kind, props.role) }).catch((e) =>
      emitWith<ToastEvent>(TOAST, { message: `Could not open the browser: ${String(e)}` }),
    );
  return (
    <div class={props.class}>
      <Button
        size="xs"
        iconRight={<Icon icon={ExternalLink} />}
        aria-label={`More ${props.role === "secondary" ? "linters" : NOUN[props.kind]}`}
        onClick={open}
      >
        More
      </Button>
    </div>
  );
}

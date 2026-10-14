import { Show } from "solid-js";
import { Inbox } from "lucide-solid";
import Button from "../../components/Button/Button";
import Icon from "../../components/Icon/Icon";
import Popover from "../../components/Popover/Popover";
import { emit, TOGGLE_INBOX } from "../../utils/events";
import { needsYouCount } from "../../utils/needsYouInbox";
import { inboxOpen, reviewItems, setInboxOpen } from "../../utils/reviewInbox";
import InboxView from "./InboxView";
import styles from "./InboxButton.module.css";

export default function InboxButton() {
  let anchor: HTMLButtonElement | undefined;
  let landing: HTMLElement | undefined;
  const count = () => reviewItems().length + needsYouCount();
  return (
    <>
      <span class={`topbar-inbox ${styles.anchor}`}>
        <Button
          ref={anchor}
          variant="ghost"
          aria-label={count() ? `Inbox, ${count()} items` : "Inbox"}
          aria-expanded={inboxOpen()}
          tooltip="Inbox (⌘⇧X)"
          onClick={() => emit(TOGGLE_INBOX)}
          icon={<Icon icon={Inbox} />}
        />
        <Show when={count() > 0}>
          <span class={styles.bubble} aria-hidden="true">
            {count() > 99 ? "99+" : count()}
          </span>
        </Show>
      </span>
      <Show when={inboxOpen()}>
        <Popover
          anchorEl={anchor}
          placement="bottom-end"
          class={styles.surface}
          aria-label="Inbox"
          initialFocus={() => landing}
          onClose={() => setInboxOpen(false)}
        >
          <InboxView landing={(el) => (landing = el)} />
        </Popover>
      </Show>
    </>
  );
}

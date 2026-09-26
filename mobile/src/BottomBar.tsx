import { For, Show, createEffect } from "solid-js";
import { Tag } from "lucide-solid";
import Icon from "../../src/components/Icon/Icon";
import { resolveIcon } from "../../src/components/Icon/iconRegistry";
import { WheelGlyph } from "../../src/components/Autopilot/Wheel";
import { spaceInitials } from "../../src/utils/names";
import type { Runner } from "./Autopilot";
import type { RootTab } from "./Root";
import { projectRows, type SessionRow, type Space } from "./tree";
import styles from "./shell.module.css";

export default function BottomBar(props: {
  spaces: Space[];
  space: Space | undefined;
  tab: RootTab;
  live: () => SessionRow[];
  showWheel: boolean;
  runner: () => Runner | null;
  decisions: () => number;
  onSpace: (space: Space) => void;
  onTopics: () => void;
  onWheel: () => void;
}) {
  const busy = (space: Space) => space.projects.some((project) => projectRows(project, props.live()).length > 0);
  const on = () => (props.runner()?.state ?? "off") !== "off";
  return (
    <>
      <div class={styles.fade} />
      <nav class={styles.bar}>
        <div class={styles.spaces}>
          <For each={props.spaces}>
            {(space) => {
              const current = () => props.tab === "projects" && space.name === props.space?.name;
              const glyph = () => resolveIcon(space.icon);
              return (
                <button
                  ref={(el) => createEffect(() => current() && el.scrollIntoView({ inline: "nearest", block: "nearest" }))}
                  class={styles.barItem}
                  aria-current={current()}
                  aria-label={space.name}
                  onClick={() => props.onSpace(space)}
                >
                  <Show when={glyph()} fallback={<span class={styles.initial}>{spaceInitials(space.name)}</span>}>
                    {(g) => <Icon icon={g()} size={19} strokeWidth={1.9} />}
                  </Show>
                  <Show when={current()}>
                    <span class={styles.spaceName}>{space.name}</span>
                  </Show>
                  <Show when={busy(space)}>
                    <span class={styles.activity} />
                  </Show>
                </button>
              );
            }}
          </For>
        </div>
        <span class={styles.divider} />
        <button class={styles.barItem} aria-current={props.tab === "topics"} aria-label="Topics" onClick={() => props.onTopics()}>
          <Icon icon={Tag} size={19} strokeWidth={1.9} />
          <Show when={props.tab === "topics"}>
            <span class={styles.spaceName}>Topics</span>
          </Show>
        </button>
        <span class={styles.spacer} />
        <Show when={props.showWheel}>
          <button class={styles.wheel} data-on={on()} aria-label="Autopilot" onClick={() => props.onWheel()}>
            <WheelGlyph size={24} />
            <Show when={on() && props.decisions() > 0}>
              <span class={styles.wheelBadge}>{props.decisions()}</span>
            </Show>
          </button>
        </Show>
      </nav>
    </>
  );
}

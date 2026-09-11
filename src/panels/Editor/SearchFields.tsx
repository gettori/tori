import { For, Show, type JSX } from "solid-js";
import { BookOpen, CaseSensitive, ListFilter, Regex, WholeWord, type LucideIcon } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import Tooltip from "../../components/Tooltip/Tooltip";
import MemberChipRow from "../../components/MemberChipRow/MemberChipRow";
import type { TintedMember } from "../../utils/featureMembers";
import { isUnsupported, unsupportedReason, type SearchOptions, type ToggleKey } from "../../utils/searchOptions";
import styles from "./SearchFields.module.css";

/** A toggle drawn inside a field, VS Code's Aa / ab / .* look. Without
 *  `active` it is a plain action in the same dress. */
export function InlineToggle(props: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: (e: MouseEvent) => void;
}) {
  return (
    <Tooltip
      as="button"
      type="button"
      class={styles.toggle}
      classList={{ [styles.on]: !!props.active }}
      label={props.label}
      aria-label={props.label}
      aria-pressed={props.active}
      disabled={props.disabled}
      whenDisabled={props.disabled}
      onClick={(e: MouseEvent) => props.onClick(e)}
    >
      <Icon icon={props.icon} />
    </Tooltip>
  );
}

/** An input with its toggles inside the border, on the right. */
export function Field(props: {
  value: string;
  placeholder?: string;
  label: string;
  describedBy?: string;
  ref?: (el: HTMLInputElement) => void;
  onInput: (v: string) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  children?: JSX.Element;
}) {
  return (
    <div class={styles.field}>
      <input
        ref={props.ref}
        class={styles.input}
        type="text"
        spellcheck={false}
        placeholder={props.placeholder}
        aria-label={props.label}
        aria-describedby={props.describedBy}
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        onKeyDown={(e) => props.onKeyDown?.(e)}
      />
      <Show when={props.children}>
        <span class={styles.toggles}>{props.children}</span>
      </Show>
    </div>
  );
}

const MATCH_TOGGLES: { key: Exclude<ToggleKey, "noIgnore">; icon: LucideIcon; label: string }[] = [
  { key: "case", icon: CaseSensitive, label: "Match Case" },
  { key: "wholeWord", icon: WholeWord, label: "Match Whole Word" },
  { key: "regex", icon: Regex, label: "Use Regular Expression" },
];

/** The query's three toggles. A backend that cannot honour one says so in the
 *  tooltip rather than leaving an inert button. */
export function MatchToggles(props: {
  options: SearchOptions;
  unsupported: string[];
  backend: string;
  onToggle: (key: ToggleKey) => void;
}) {
  return (
    <For each={MATCH_TOGGLES}>
      {(t) => {
        const off = () => isUnsupported(props.unsupported, t.key);
        return (
          <InlineToggle
            icon={t.icon}
            label={off() ? `${t.label}. ${unsupportedReason(t.key, props.backend)}` : t.label}
            active={props.options[t.key]}
            disabled={off()}
            onClick={() => props.onToggle(t.key)}
          />
        );
      }}
    </For>
  );
}

/** "files to include" and "files to exclude", each under its own label. */
export function GlobFields(props: {
  id?: string;
  options: SearchOptions;
  unsupported: string[];
  backend: string;
  openOnly: boolean;
  onGlob: (key: "include" | "exclude", v: string) => void;
  onOpenOnly: () => void;
  onToggleIgnore: () => void;
}) {
  // VS Code's toggle is "use the ignore files", so on means noIgnore is off.
  const ignoreOff = () => isUnsupported(props.unsupported, "noIgnore");
  return (
    <div class={styles.globs} id={props.id}>
      <div class={styles.globLabel}>
        <span>files to include</span>
        <Field
          value={props.options.include}
          label="files to include"
          placeholder="e.g. src/**/*.ts"
          onInput={(v) => props.onGlob("include", v)}
        >
          <InlineToggle
            icon={BookOpen}
            label="Search Only in Open Editors"
            active={props.openOnly}
            onClick={props.onOpenOnly}
          />
        </Field>
      </div>
      <div class={styles.globLabel}>
        <span>files to exclude</span>
        <Field
          value={props.options.exclude}
          label="files to exclude"
          placeholder="e.g. **/*.test.ts"
          onInput={(v) => props.onGlob("exclude", v)}
        >
          <InlineToggle
            icon={ListFilter}
            label={
              ignoreOff()
                ? `Use Exclude Settings and Ignore Files. ${unsupportedReason("noIgnore", props.backend)}`
                : "Use Exclude Settings and Ignore Files"
            }
            active={!props.options.noIgnore}
            disabled={ignoreOff()}
            onClick={props.onToggleIgnore}
          />
        </Field>
      </div>
    </div>
  );
}

/** Which members a search covers. Every chip lit means every member; clicking
 *  one turns it off, and turning off the last lit one goes back to all. */
export function MemberToggles(props: {
  members: readonly TintedMember[];
  restricted: readonly string[];
  onChange: (repos: string[]) => void;
}) {
  const usable = () => props.members.filter((m) => m.state.usable).map((m) => m.member.repoPath);
  const isOn = (m: TintedMember) =>
    m.state.usable && (!props.restricted.length || props.restricted.includes(m.member.repoPath));
  function toggle(m: TintedMember) {
    const now = props.restricted.length ? [...props.restricted] : usable();
    const repo = m.member.repoPath;
    const next = now.includes(repo) ? now.filter((p) => p !== repo) : [...now, repo];
    props.onChange(!next.length || next.length === usable().length ? [] : next);
  }
  return (
    <MemberChipRow
      bare
      cap={4}
      members={props.members}
      activeRoot={null}
      isOn={isOn}
      canPick={(m) => m.state.usable}
      onPick={toggle}
    />
  );
}

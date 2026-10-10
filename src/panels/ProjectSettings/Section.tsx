import { createContext, createSignal, onCleanup, Show, useContext, type Accessor, type JSX } from "solid-js";
import s from "../Settings/Settings.module.css";
import own from "./ProjectSettingsDialog.module.css";

/** The rail's search, as each pane hands it down: the query, lowercased and
 *  trimmed, and whether it names the pane itself, which shows the pane whole. */
export const ProjectSearch = createContext<{ query: Accessor<string>; paneHit: Accessor<boolean> }>({
  query: () => "",
  paneHit: () => false,
});

const SectionScope = createContext<{
  query: Accessor<string>;
  narrow: Accessor<boolean>;
  register: (hit: Accessor<boolean>) => void;
}>();

// Read off the DOM rather than off props: a row's label, hint and control are
// JSX, and what a reader searches for is the text they see.
const holds = (el: HTMLElement | undefined, q: string) => !!el?.textContent?.toLowerCase().includes(q);

/**
 * A titled group, in the shape a Settings pane draws one.
 *
 * Under a search it shows whole when its heading or its pane matches, only
 * its matching rows when a row does, whole when only text outside the rows
 * does (a card, a list), and not at all otherwise.
 */
export function Section(props: { heading: string; meta?: JSX.Element; children: JSX.Element }) {
  const search = useContext(ProjectSearch);
  const [rows, setRows] = createSignal<Accessor<boolean>[]>([]);
  let el: HTMLElement | undefined;

  const headingHit = () => !search.query() || search.paneHit() || props.heading.toLowerCase().includes(search.query());
  const narrow = () => !headingHit() && rows().some((hit) => hit());
  const shown = () => headingHit() || holds(el, search.query());

  const register = (hit: Accessor<boolean>) => {
    setRows((now) => [...now, hit]);
    onCleanup(() => setRows((now) => now.filter((h) => h !== hit)));
  };

  return (
    <SectionScope.Provider value={{ query: search.query, narrow, register }}>
      <section ref={el} class={`${s.section} ${own.section}`} hidden={!shown()} data-narrow={narrow() ? "" : undefined}>
        <div class={`${s.sectionTitle} ${own.sectionTitle}`}>
          <span>{props.heading}</span>
          <span class={s.sectionRule} />
          <Show when={props.meta}>
            <span class={own.meta}>{props.meta}</span>
          </Show>
        </div>
        {props.children}
      </section>
    </SectionScope.Provider>
  );
}

/** A label at the left and its control at the right, with the hint under the
 *  label, as Settings lays out a row. `stack` puts the control under the label
 *  at full width, and the hint under the control. */
export function Row(props: { label: JSX.Element; hint?: JSX.Element; stack?: boolean; children?: JSX.Element }) {
  const scope = useContext(SectionScope);
  let el: HTMLDivElement | undefined;
  const hit = () => !!scope?.query() && holds(el, scope.query());
  scope?.register(hit);

  return (
    <div
      ref={el}
      class={`${s.row} ${own.row}`}
      classList={{ [s.rowStack]: !!props.stack }}
      hidden={!!scope?.narrow() && !hit()}
    >
      <span class={s.label}>{props.label}</span>
      <div class={s.control}>{props.children}</div>
      <Show when={props.hint}>
        <div class={s.hint}>{props.hint}</div>
      </Show>
    </div>
  );
}

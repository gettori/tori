import { Show, type JSX } from "solid-js";
import s from "../Settings/Settings.module.css";
import own from "./ProjectSettingsDialog.module.css";

/** A titled group, in the shape a Settings pane draws one, so the dialog reads as
 *  the same kind of surface. */
export function Section(props: { heading: string; meta?: JSX.Element; children: JSX.Element }) {
  return (
    <section class={s.section}>
      <div class={s.sectionTitle}>
        <span>{props.heading}</span>
        <span class={s.sectionRule} />
        <Show when={props.meta}>
          <span class={own.meta}>{props.meta}</span>
        </Show>
      </div>
      {props.children}
    </section>
  );
}

/** A label at the left and its control at the right, with the hint under the
 *  label, as Settings lays out a row. */
export function Row(props: { label: JSX.Element; hint?: JSX.Element; children?: JSX.Element }) {
  return (
    <div class={s.row}>
      <span class={s.label}>{props.label}</span>
      <div class={s.control}>{props.children}</div>
      <Show when={props.hint}>
        <div class={s.hint}>{props.hint}</div>
      </Show>
    </div>
  );
}

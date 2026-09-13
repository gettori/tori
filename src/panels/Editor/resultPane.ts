// Every conflict keeps a span in the Result document, mapped through the
// reader's own edits, so a choice made after a hand edit replaces the right
// lines rather than the lines that were there when the pane opened.
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { decided, type Choice, type ResultSlot, type Side, type SideLabels } from "../../utils/conflict";

export type ResultState = { slots: ResultSlot[]; choices: Record<string, Choice>; ignored: Record<string, Side[]> };

/** A fresh seed: new spans, nothing decided. Carries the document with it. */
export const resetResult = StateEffect.define<ResultState>();

/** One conflict answered. Rides with the change that replaces its lines. */
export const decideRegion = StateEffect.define<{ id: string; choice: Choice }>();

/** One side of a conflict set aside or taken back, which changes no text. */
export const ignoreSide = StateEffect.define<{ id: string; side: Side; ignored: boolean }>();

/** How a slot's buttons report back, since the view does not own the choices. */
export type Choose = (id: string, choice: Choice) => void;

export type ChoiceOption = { choice: Choice; text: string; name: string };

/** One region's choices for the slot to offer. */
export type OptionsFor = (id: string) => ChoiceOption[];

/** What each choice for one region is called, both on the slot's own buttons
 *  and on the header's. The two side names come from the running operation,
 *  never from the stage: under a rebase the version git calls "ours" is the
 *  upstream's. `both` is the region's `bothChoices`, and a combination names
 *  its order only when it is offered in two. */
export function choiceOptions(labels: SideLabels, both: Choice[]): ChoiceOption[] {
  const combined = (choice: Choice): ChoiceOption => {
    if (choice === "both") return { choice, text: "Both", name: "Keep both versions, ours first" };
    const first = labels[choice === "combine-theirs" ? "theirs" : "ours"];
    return both.length > 1
      ? { choice, text: `Combine, ${first} first`, name: `Combine both sides' edits, ${first} first` }
      : { choice, text: "Combine", name: "Combine both sides' edits" };
  };
  return [
    { choice: "ours", text: labels.ours, name: `Take ${labels.ours}` },
    { choice: "theirs", text: labels.theirs, name: `Take ${labels.theirs}` },
    ...both.map(combined),
    { choice: "hand", text: "By hand", name: "Write these lines yourself" },
  ];
}

class SlotWidget extends WidgetType {
  constructor(
    readonly id: string,
    readonly options: ChoiceOption[],
    readonly choose: Choose,
  ) {
    super();
  }

  eq(other: SlotWidget): boolean {
    const names = (widget: SlotWidget) => widget.options.map((o) => o.name).join();
    return other.id === this.id && names(other) === names(this);
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-result-slot";

    const label = document.createElement("span");
    label.className = "cm-result-slot-label";
    label.textContent = "Undecided";
    wrap.appendChild(label);

    for (const option of this.options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cm-result-slot-button";
      button.textContent = option.text;
      // The visible text is a side's name on its own, which says nothing about
      // what pressing it does; the name has to carry the verb.
      button.setAttribute("aria-label", option.name);
      button.title = option.name;
      button.onclick = () => this.choose(this.id, option.choice);
      wrap.appendChild(button);
    }
    return wrap;
  }

  // Everything inside belongs to the widget, so the editor must not treat a
  // click on a button as a click in the document.
  ignoreEvent(): boolean {
    return true;
  }
}

function slotDecorations(state: ResultState, options: OptionsFor, choose: Choose): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const slot of state.slots) {
    if (decided(slot.id, state.choices, state.ignored)) continue;
    builder.add(
      slot.from,
      slot.from,
      Decoration.widget({ widget: new SlotWidget(slot.id, options(slot.id), choose), block: true, side: -1 }),
    );
  }
  return builder.finish();
}

/**
 * Where each conflict's lines are in this document, and which of them have been
 * answered.
 *
 * A field rather than state held outside the editor because the spans have to
 * survive the reader typing: only a transaction knows how a hand edit moved the
 * lines below it, and a span kept outside would be describing the document as
 * it was when the pane opened.
 */
export function resultField(options: OptionsFor, choose: Choose): StateField<ResultState> {
  return StateField.define<ResultState>({
    create: () => ({ slots: [], choices: {}, ignored: {} }),
    update(value, tr) {
      let next = value;
      for (const effect of tr.effects) {
        if (effect.is(resetResult)) return effect.value;
        if (effect.is(decideRegion)) {
          next = { ...next, choices: { ...next.choices, [effect.value.id]: effect.value.choice } };
        }
        if (effect.is(ignoreSide)) {
          const { id, side, ignored } = effect.value;
          const aside = (next.ignored[id] ?? []).filter((s) => s !== side);
          next = { ...next, ignored: { ...next.ignored, [id]: ignored ? [...aside, side] : aside } };
        }
      }
      if (tr.docChanged) {
        next = {
          ...next,
          // Outward on both ends: a choice replaces the whole span, and text
          // typed at either edge of a region is part of that region rather than
          // of the untouched lines beside it.
          slots: next.slots.map((slot) => ({
            id: slot.id,
            from: tr.changes.mapPos(slot.from, -1),
            to: tr.changes.mapPos(slot.to, 1),
          })),
        };
      }
      return next;
    },
    provide: (field) =>
      EditorView.decorations.from(field, (value) => slotDecorations(value, options, choose)),
  });
}

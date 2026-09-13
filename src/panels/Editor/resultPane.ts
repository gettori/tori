// Every conflict keeps a span in the Result document, mapped through the
// reader's own edits, so a choice made after a hand edit replaces the right
// lines rather than the lines that were there when the pane opened.
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { RangeSetBuilder, StateEffect, StateField, type Text } from "@codemirror/state";
import {
  decided,
  keeps,
  withoutSide,
  type Choice,
  type ResultSlot,
  type Side,
  type SideLabels,
} from "../../utils/conflict";

export type ResultState = {
  slots: ResultSlot[];
  choices: Record<string, Choice>;
  ignored: Record<string, Side[]>;
  // What an action last wrote into each slot. Typing is measured against it.
  placed: Record<string, string>;
};

/** A fresh seed: new spans, nothing decided. Carries the document with it. */
export const resetResult = StateEffect.define<Omit<ResultState, "placed">>();

/** One conflict answered, or opened again with null. Rides with the change
 *  that replaces its lines. */
export const decideRegion = StateEffect.define<{ id: string; choice: Choice | null }>();

/** One side of a conflict set aside or taken back, which changes no text. */
export const ignoreSide = StateEffect.define<{ id: string; side: Side; ignored: boolean }>();

export type SlotActions = { choose(id: string, choice: Choice | null): void; reset(id: string): void };

export type ChoiceOption = { choice: Choice; text: string; name: string; readout: string };

/** One region's choices for the slot to offer. */
export type OptionsFor = (id: string) => ChoiceOption[];

/** What each choice for one region is called, both on the slot's own buttons
 *  and on the header's. The two side names come from the running operation,
 *  never from the stage: under a rebase the version git calls "ours" is the
 *  upstream's. `both` is the region's `bothChoices`, and a combination names
 *  its order only when it is offered in two. */
export function choiceOptions(labels: SideLabels, both: Choice[]): ChoiceOption[] {
  const combined = (choice: Choice): ChoiceOption => {
    if (choice === "both") {
      return { choice, text: "Both", name: "Keep both versions, ours first", readout: "Holds both versions, ours first" };
    }
    const first = labels[choice === "combine-theirs" ? "theirs" : "ours"];
    return both.length > 1
      ? {
          choice,
          text: `Combine, ${first} first`,
          name: `Combine both sides' edits, ${first} first`,
          readout: `Holds both sides' edits, ${first} first`,
        }
      : { choice, text: "Combine", name: "Combine both sides' edits", readout: "Holds both sides' edits combined" };
  };
  return [
    { choice: "ours", text: labels.ours, name: `Take ${labels.ours}`, readout: `Holds ${labels.ours}` },
    { choice: "theirs", text: labels.theirs, name: `Take ${labels.theirs}`, readout: `Holds ${labels.theirs}` },
    ...both.map(combined),
    { choice: "hand", text: "By hand", name: "Write these lines yourself", readout: "Written by hand" },
  ];
}

export function editedByHand(state: ResultState, doc: Text, id: string): boolean {
  const slot = state.slots.find((s) => s.id === id);
  return !!slot && id in state.placed && doc.sliceString(slot.from, slot.to) !== state.placed[id];
}

class SlotWidget extends WidgetType {
  constructor(
    readonly id: string,
    readonly options: ChoiceOption[],
    readonly choice: Choice | undefined,
    readonly settled: boolean,
    readonly act: SlotActions,
  ) {
    super();
  }

  eq(other: SlotWidget): boolean {
    const names = (widget: SlotWidget) => widget.options.map((o) => o.name).join();
    return (
      other.id === this.id &&
      other.choice === this.choice &&
      other.settled === this.settled &&
      names(other) === names(this)
    );
  }

  toDOM(): HTMLElement {
    const { id, choice, act } = this;
    const wrap = document.createElement("div");
    wrap.className = this.settled ? "cm-result-slot cm-result-slot-decided" : "cm-result-slot";

    const label = document.createElement("span");
    label.className = "cm-result-slot-label";
    label.textContent =
      this.options.find((o) => o.choice === choice)?.readout ?? (this.settled ? "Both sides ignored" : "Undecided");
    wrap.appendChild(label);

    const sideText = (side: Side) => this.options.find((o) => o.choice === side)!.text;
    const buttons: { text: string; name: string; run: () => void }[] = !choice
      ? this.settled
        ? []
        : this.options.map((o) => ({ text: o.text, name: o.name, run: () => act.choose(id, o.choice) }))
      : choice === "hand"
        ? [{ text: "Reset to base", name: "Reset to base", run: () => act.reset(id) }]
        : (["ours", "theirs"] as const)
            .filter((side) => keeps(choice, side))
            .map((side) => ({
              text: `Remove ${sideText(side)}`,
              name: `Remove ${sideText(side)}`,
              run: () => act.choose(id, withoutSide(choice, side)),
            }));

    for (const b of buttons) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cm-result-slot-button";
      button.textContent = b.text;
      // The visible text is a side's name on its own, which says nothing about
      // what pressing it does; the name has to carry the verb.
      button.setAttribute("aria-label", b.name);
      button.title = b.name;
      button.onclick = b.run;
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

function slotDecorations(state: ResultState, options: OptionsFor, act: SlotActions): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const slot of state.slots) {
    const widget = new SlotWidget(
      slot.id,
      options(slot.id),
      state.choices[slot.id],
      decided(slot.id, state.choices, state.ignored),
      act,
    );
    builder.add(slot.from, slot.from, Decoration.widget({ widget, block: true, side: -1 }));
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
export function resultField(options: OptionsFor, act: SlotActions): StateField<ResultState> {
  return StateField.define<ResultState>({
    create: () => ({ slots: [], choices: {}, ignored: {}, placed: {} }),
    update(value, tr) {
      let next = value;
      const wrote: string[] = [];
      for (const effect of tr.effects) {
        if (effect.is(resetResult)) {
          const slice = (s: ResultSlot) => [s.id, tr.newDoc.sliceString(s.from, s.to)];
          return { ...effect.value, placed: Object.fromEntries(effect.value.slots.map(slice)) };
        }
        if (effect.is(decideRegion)) {
          const { id, choice } = effect.value;
          const choices = { ...next.choices };
          if (choice) choices[id] = choice;
          else delete choices[id];
          next = { ...next, choices };
          wrote.push(id);
        }
        if (effect.is(ignoreSide)) {
          const { id, side, ignored } = effect.value;
          const aside = (next.ignored[id] ?? []).filter((s) => s !== side);
          next = { ...next, ignored: { ...next.ignored, [id]: ignored ? [...aside, side] : aside } };
        }
      }
      if (!tr.docChanged && !wrote.length) return next;

      const slots = !tr.docChanged
        ? next.slots
        : // Outward, so text typed into a region is part of it, except past a
          // span's closing newline: typing there starts the line below.
          next.slots.map((slot) => {
            const closed = slot.to > slot.from && tr.startState.doc.sliceString(slot.to - 1, slot.to) === "\n";
            return { id: slot.id, from: tr.changes.mapPos(slot.from, -1), to: tr.changes.mapPos(slot.to, closed ? -1 : 1) };
          });
      let { choices, placed } = next;
      slots.forEach((slot, i) => {
        const text = () => tr.newDoc.sliceString(slot.from, slot.to);
        if (wrote.includes(slot.id)) {
          placed = { ...placed, [slot.id]: text() };
          return;
        }
        // Typing over an answer makes the lines the reader's own. An open region
        // stays open, since half-typed text is not a decision.
        const choice = choices[slot.id];
        const before = next.slots[i];
        if (!choice || choice === "hand" || !tr.changes.touchesRange(before.from, before.to)) return;
        if (text() !== placed[slot.id]) choices = { ...choices, [slot.id]: "hand" };
      });
      return { ...next, slots, choices, placed };
    },
    provide: (field) => EditorView.decorations.from(field, (value) => slotDecorations(value, options, act)),
  });
}

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import QuestionCard from "./QuestionCard";
import type { QuestionItem } from "./chatStore";
import type { ChatQuestion } from "../../utils/chatTypes";

// Built by hand rather than cast, the same rule the tool-card tests follow: an
// `as QuestionItem` would let a fixture omit a field the store always sets, and
// the card would then throw on something that cannot happen in the app.

const CHANNEL: ChatQuestion = {
  question: "Which answer channel should the card use?",
  header: "Channel",
  multiSelect: false,
  options: [
    { label: "In protocol", description: "Answer the question the agent already asked.", preview: "behavior: deny" },
    { label: "A dedicated hook", description: "Intercept the call first.", preview: null },
  ],
};

const SCOPE: ChatQuestion = {
  question: "Which should I address?",
  header: "Scope",
  multiSelect: true,
  options: [
    { label: "The title copy", description: "", preview: null },
    { label: "The keyframe coupling", description: "", preview: null },
  ],
};

const PLACEMENT: ChatQuestion = {
  question: "Where should it render?",
  header: "Placement",
  multiSelect: false,
  options: [
    { label: "Inline", description: "", preview: null },
    { label: "Modal", description: "", preview: null },
  ],
};

const EXTRA: ChatQuestion = {
  question: "Anything else?",
  header: "Extra",
  multiSelect: false,
  options: [
    { label: "No", description: "", preview: null },
    { label: "Yes", description: "", preview: null },
  ],
};

function item(over: Partial<QuestionItem> = {}): QuestionItem {
  return {
    kind: "question",
    id: "q1",
    toolUseId: "toolu_q",
    turnId: "turn-1",
    requestId: "req-q",
    agentId: null,
    questions: [CHANNEL],
    submitted: null,
    result: null,
    ...over,
  };
}

const radio = (name: string) => screen.getByRole("radio", { name: new RegExp(name) }) as HTMLInputElement;
const box = (name: string) => screen.getByRole("checkbox", { name: new RegExp(name) }) as HTMLInputElement;
const submit = () => screen.getByRole("button", { name: /send answers/i }) as HTMLButtonElement;
const other = (n = 0) => screen.getAllByLabelText("Other")[n] as HTMLTextAreaElement;

describe("QuestionCard", () => {
  it("asks one question with radios and offers an Other box beside them", () => {
    render(() => <QuestionCard item={item()} onAnswer={() => {}} />);
    expect(screen.getByText("Which answer channel should the card use?")).toBeTruthy();
    expect(radio("In protocol")).toBeTruthy();
    expect(radio("A dedicated hook")).toBeTruthy();
    // Always present, never revealed: the tool always offers Other, and a box
    // behind a disclosure reads as an escape hatch rather than as an answer.
    expect(other()).toBeTruthy();
  });

  it("uses checkboxes for a multiSelect question and radios otherwise", () => {
    render(() => <QuestionCard item={item({ questions: [CHANNEL, SCOPE] })} onAnswer={() => {}} />);
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  });

  it("keeps Submit off until every question has an answer", () => {
    const onAnswer = vi.fn();
    render(() => <QuestionCard item={item({ questions: [CHANNEL, PLACEMENT] })} onAnswer={onAnswer} />);
    expect(submit().disabled).toBe(true);
    fireEvent.click(radio("In protocol"));
    expect(submit().disabled, "one of two answered is not answered").toBe(true);
    fireEvent.click(radio("Inline"));
    expect(submit().disabled).toBe(false);
  });

  it("counts a typed answer as an answer, with nothing picked", () => {
    // 17 of 411 measured results were exactly this: a value matching no
    // declared option. A form that required a pick could not produce one.
    render(() => <QuestionCard item={item()} onAnswer={() => {}} />);
    expect(submit().disabled).toBe(true);
    fireEvent.input(other(), { target: { value: "neither, use the fixture" } });
    expect(submit().disabled).toBe(false);
  });

  it("does not count a blank or whitespace-only box as an answer", () => {
    render(() => <QuestionCard item={item()} onAnswer={() => {}} />);
    fireEvent.input(other(), { target: { value: "   " } });
    expect(submit().disabled).toBe(true);
  });

  it("shows the picked option's preview, and only when it has one", () => {
    render(() => <QuestionCard item={item()} onAnswer={() => {}} />);
    expect(screen.queryByText("behavior: deny")).toBeNull();
    fireEvent.click(radio("In protocol"));
    expect(screen.getByText("behavior: deny")).toBeTruthy();
    fireEvent.click(radio("A dedicated hook"));
    expect(screen.queryByText("behavior: deny"), "the other option declares none").toBeNull();
  });

  it("sends one answer per question, with picks and typed text kept apart", () => {
    const onAnswer = vi.fn();
    render(() => (
      <QuestionCard item={item({ questions: [CHANNEL, SCOPE, PLACEMENT, EXTRA] })} onAnswer={onAnswer} />
    ));
    fireEvent.click(radio("In protocol"));
    fireEvent.click(box("The title copy"));
    fireEvent.click(box("The keyframe coupling"));
    fireEvent.click(radio("Inline"));
    fireEvent.input(other(3), { target: { value: "  ask me again after the diff  " } });

    fireEvent.click(submit());
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer.mock.calls[0][0]).toEqual([
      { question: "Which answer channel should the card use?", picks: ["In protocol"], freeText: null },
      // Options order, not click order, so the answer string is stable however
      // the boxes were hit.
      { question: "Which should I address?", picks: ["The title copy", "The keyframe coupling"], freeText: null },
      { question: "Where should it render?", picks: ["Inline"], freeText: null },
      // Trimmed, because the trailing spaces would travel to the model.
      { question: "Anything else?", picks: [], freeText: "ask me again after the diff" },
    ]);
  });

  it("cannot be submitted twice", () => {
    // The request behind it takes exactly one answer, and the store settles the
    // item asynchronously, so the card has to refuse the second press itself.
    const onAnswer = vi.fn();
    render(() => <QuestionCard item={item()} onAnswer={onAnswer} />);
    fireEvent.click(radio("In protocol"));
    fireEvent.click(submit());
    fireEvent.click(submit());
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it("renders a replayed question read only, with the record and never the input JSON", () => {
    const record =
      'Your questions have been answered: "Which answer channel should the card use?"="In protocol". ' +
      "You can now continue with these answers in mind.";
    render(() => (
      <QuestionCard item={item({ requestId: null, result: record })} onAnswer={() => {}} />
    ));
    expect(screen.getByText("Which answer channel should the card use?")).toBeTruthy();
    expect(screen.getByText(record)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /send answers/i }), "nothing to send").toBeNull();
    expect(radio("In protocol").disabled).toBe(true);
    expect(other().disabled).toBe(true);
    // The raw arguments are what the old tool card showed. A question row that
    // fell back to them would be the failure this whole item exists to fix.
    expect(document.body.textContent).not.toContain("multiSelect");
  });

  it("reads as read only when the caller can send nothing", () => {
    render(() => <QuestionCard item={item()} />);
    expect(screen.queryByRole("button", { name: /send answers/i })).toBeNull();
    expect(radio("In protocol").disabled).toBe(true);
  });

  it("says a subagent asked, without putting its id anywhere only a mouse finds", () => {
    render(() => <QuestionCard item={item({ agentId: "affdd797eddcfa753" })} onAnswer={() => {}} />);
    const badge = screen.getByText("from a subagent");
    // No `title`: hover text is the one place a keyboard user would never
    // reach, and a hex handle nobody recognises is not worth a control.
    expect(badge.getAttribute("title")).toBeNull();
    expect(document.body.textContent).not.toContain("affdd797eddcfa753");
  });

  it("says nothing about a subagent when the main agent asked", () => {
    render(() => <QuestionCard item={item()} onAnswer={() => {}} />);
    expect(screen.queryByText("from a subagent")).toBeNull();
  });

  it("names every control, so the form is answerable from the keyboard alone", async () => {
    render(() => <QuestionCard item={item({ questions: [CHANNEL, SCOPE] })} onAnswer={() => {}} />);
    // The group labels are the question prose, which is what a screen reader
    // announces before the options.
    expect(screen.getByRole("radiogroup", { name: /Which answer channel should the card use\?/ })).toBeTruthy();
    expect(screen.getByRole("group", { name: /Which should I address\?/ })).toBeTruthy();
    await expectNoAxeViolations(document.body);
  });

  it("stays clean once answered", async () => {
    render(() => (
      <QuestionCard item={item({ requestId: null, result: "Your questions have been answered." })} />
    ));
    await expectNoAxeViolations(document.body);
  });
});

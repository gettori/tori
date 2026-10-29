import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import { render } from "solid-js/web";
import type { ContentBlock, RefTarget } from "../../utils/chatTypes";
import { emitWith, NAVIGATE, OPEN_IN_EDITOR, SESSION_ACTION } from "../../utils/events";
import type { NavTarget, OpenInEditor, SessionAction } from "../../utils/events";
import { openPrByNumber } from "../../utils/openPrTab";
import { AttachmentChip, AttachmentGrid, InlineChip, type HeldBlock } from "./AttachmentChip";
import AttachmentPreview from "./AttachmentPreview";
import { createPromptField, type ChipSpec } from "./composerField";
import styles from "./Chat.module.css";

function openRef(t: RefTarget, cwd: string) {
  if (t.kind === "pr") void openPrByNumber(cwd, t.number);
  else if (t.kind === "session") emitWith<SessionAction>(SESSION_ACTION, { sessionId: t.id, action: "open" });
  else if (t.kind === "project") emitWith<NavTarget>(NAVIGATE, { project: t.folder });
  else emitWith<NavTarget>(NAVIGATE, { space: t.name });
}

/** The typed text, and what was attached ahead of it. A send puts the draft
 *  last and its attachments before it, and a replay reads them back in that
 *  order, so a text block anywhere else is an attached note. */
function splitPrompt(blocks: readonly ContentBlock[]): { text: string; held: HeldBlock[] } {
  const last = blocks[blocks.length - 1];
  const typed = last?.type === "text";
  const held = (typed ? blocks.slice(0, -1) : blocks).map((block, i) => ({ id: String(i), block }));
  return { text: typed ? last.text : "", held };
}

function labelOf(block: ContentBlock): string | null {
  if (block.type === "fileRef") return block.label ?? null;
  return block.type === "ref" ? block.label : null;
}

function PromptTextField(props: {
  text: string;
  skills: readonly string[];
  chipFor: (label: string) => ChipSpec | null;
}) {
  let host!: HTMLDivElement;
  onMount(() => {
    const field = createPromptField({
      parent: host,
      doc: untrack(() => props.text),
      skills: untrack(() => props.skills),
      chipFor: props.chipFor,
    });
    onCleanup(() => field.destroy());
    createEffect(
      on(
        () => props.text,
        (t) => field.set(t),
        { defer: true },
      ),
    );
    createEffect(
      on(
        () => props.skills,
        (names) => field.setSkills(names),
        { defer: true },
      ),
    );
  });
  return <div ref={host} class={styles.promptField} />;
}

/**
 * A sent prompt, drawn the way the composer drew it: the attachments above as
 * tiles and pills, the text in the same field with its chips and highlighting.
 * Everything previews; nothing edits, removes or drags.
 *
 * A token is a chip only for one of this turn's own attachments: a user who
 * typed `[Image 9]` at an agent that never got one meant those characters.
 */
export default function SentPrompt(props: { blocks: readonly ContentBlock[]; cwd: string; skills: readonly string[] }) {
  const prompt = createMemo(() => splitPrompt(props.blocks));
  const [pointing, setPointing] = createSignal<string | null>(null);
  const [previewing, setPreviewing] = createSignal<ContentBlock | null>(null);

  const chipFor = (label: string): ChipSpec | null => {
    const a = untrack(prompt).held.find((h) => labelOf(h.block) === label);
    if (!a) return null;
    return {
      key: a.id,
      mount: (dom) =>
        render(
          () => (
            <InlineChip
              label={label}
              block={a.block}
              onPoint={(on) => setPointing(on ? a.id : null)}
              onPreview={() => setPreviewing(a.block)}
            />
          ),
          dom,
        ),
    };
  };

  return (
    <>
      <AttachmentGrid
        items={prompt().held}
        chip={(a) => (
          <AttachmentChip block={a.block} pointed={pointing() === a.id} onPreview={() => setPreviewing(a.block)} />
        )}
      />
      <Show when={prompt().text}>
        {(text) => <PromptTextField text={text()} skills={props.skills} chipFor={chipFor} />}
      </Show>
      <AttachmentPreview
        block={previewing()}
        missing={false}
        onClose={() => setPreviewing(null)}
        onOpenInEditor={(path, line) =>
          emitWith<OpenInEditor>(OPEN_IN_EDITOR, line === null ? { path } : { path, line })
        }
        onOpenRef={(t) => openRef(t, props.cwd)}
      />
    </>
  );
}

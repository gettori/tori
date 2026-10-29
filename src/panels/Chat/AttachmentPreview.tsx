import { For, Match, Show, Switch, createResource, type JSX } from "solid-js";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import Dialog from "../../components/Dialog/Dialog";
import Button from "../../components/Button/Button";
import PdfView from "../Editor/PdfView";
import CodeBlock from "./CodeBlock";
import { langOfPath } from "./highlight";
import { attachmentKind } from "../../utils/chatCompose";
import type { ContentBlock, RefTarget } from "../../utils/chatTypes";
import { attachmentTip, thumbSrc } from "./attachmentInfo";
import styles from "./Chat.module.css";

type FileRef = Extract<ContentBlock, { type: "fileRef" }>;

/** The lines a selection covers, or the whole file. A selection that carried its
 *  own text shows that, since it is what the agent will be sent. */
function regionOf(block: FileRef, file: string): string {
  if (block.text) return block.text;
  if (block.startLine === null) return file;
  const end = block.endLine ?? block.startLine;
  return file
    .split("\n")
    .slice(block.startLine - 1, end)
    .join("\n");
}

function FileText(props: { block: FileRef }) {
  // A selection that carries its text needs no read at all, which is also what
  // keeps a preview working for a file deleted since it was selected.
  const [file] = createResource(
    () => (props.block.text ? null : props.block.path),
    (path: string) => invoke<string>("fs_read_file", { path }),
  );
  return (
    <Show
      when={props.block.text || file()}
      fallback={
        <Show when={file.error} fallback={<p class={styles.previewNote}>Reading the file...</p>}>
          <p class={styles.previewNote}>This file cannot be shown as text.</p>
        </Show>
      }
    >
      <CodeBlock lang={langOfPath(props.block.path)} code={regionOf(props.block, file() ?? "")} />
    </Show>
  );
}

function textOf(block: ContentBlock): string | null {
  return block.type === "text" ? block.text : null;
}

/** A link's facts, and the address the agent will be pointed at. */
function factsOf(block: ContentBlock): string[] {
  const lines = [...(attachmentTip(block).lines ?? [])];
  if (block.type === "ref" && block.target.kind === "pr") lines.push(block.target.url);
  return lines;
}

const OPEN_REF = {
  pr: "Open pull request",
  session: "Open session",
  project: "Show project",
  space: "Show space",
} as const;

function Facts(props: { lines: readonly string[] }) {
  return (
    <ul class={styles.previewFacts}>
      <For each={props.lines}>{(line) => <li>{line}</li>}</For>
    </ul>
  );
}

/**
 * What an attachment is, opened from its chip. Each kind is shown by the viewer
 * the editor already has for it, so a picture, a PDF and a source file look the
 * same here as in a tab; a link to a pull request or a session, which has no
 * file, shows what the agent will be told about it.
 */
export default function AttachmentPreview(props: {
  block: ContentBlock | null;
  missing: boolean;
  onClose: () => void;
  onOpenInEditor: (path: string, line: number | null) => void;
  /** Go to what a link names, inside Tori. */
  onOpenRef?: (target: RefTarget) => void;
}) {
  const fileRef = () => (props.block?.type === "fileRef" ? props.block : null);
  const kind = () => {
    const f = fileRef();
    return f ? attachmentKind(f.path) : null;
  };
  const tip = () => (props.block ? attachmentTip(props.block) : null);

  const actions = (): JSX.Element => (
    <>
      <Show when={props.onOpenRef && props.block?.type === "ref" ? props.block.target : null}>
        {(t) => (
          <Button
            onClick={() => {
              props.onOpenRef?.(t());
              props.onClose();
            }}
          >
            {OPEN_REF[t().kind]}
          </Button>
        )}
      </Show>
      <Show when={props.block?.type === "ref" && props.block.target.kind === "pr" ? props.block.target : null}>
        {(pr) => (
          <Button onClick={() => void invoke("plugin:opener|open_url", { url: pr().url }).catch(() => {})}>
            Open on the forge
          </Button>
        )}
      </Show>
      <Show when={fileRef() && !props.missing ? fileRef() : null}>
        {(f) => (
          <Button
            onClick={() => {
              props.onOpenInEditor(f().path, f().startLine);
              props.onClose();
            }}
          >
            Open in editor
          </Button>
        )}
      </Show>
      <Button variant="primary" onClick={() => props.onClose()}>
        Close
      </Button>
    </>
  );

  return (
    <Dialog
      open={props.block !== null}
      title={tip()?.heading ?? ""}
      // A file's facts head its viewer. Anything else has only facts, which
      // the body shows, so saying them here as well would say them twice.
      description={fileRef() ? tip()?.lines?.join(", ") : undefined}
      size="wide"
      onClose={() => props.onClose()}
      actions={actions()}
    >
      <Show when={props.block}>
        {(block) => (
          <Switch fallback={<Facts lines={factsOf(block())} />}>
            <Match when={props.missing && fileRef()}>
              {(f) => (
                <p class={styles.previewNote}>
                  No file at {f().path} any more. It was moved or deleted after it was attached.
                </p>
              )}
            </Match>
            {/* Fitted to the dialog rather than the editor's full size viewer,
                which scrolls a screenshot at its natural size. Open in editor
                is the way to that. */}
            <Match when={block().type === "image" || kind() === "image" ? block() : null}>
              {(b) => (
                <img
                  class={styles.previewImage}
                  src={thumbSrc(b()) ?? convertFileSrc(fileRef()!.path)}
                  alt={tip()?.heading ?? "Image"}
                />
              )}
            </Match>
            <Match when={kind() === "pdf" ? fileRef() : null}>
              {(f) => (
                <div class={styles.previewFrame}>
                  <PdfView
                    path={f().path}
                    goto={f().startLine === null ? null : { path: f().path, line: f().startLine!, nonce: 1 }}
                  />
                </div>
              )}
            </Match>
            <Match when={fileRef()}>{(f) => <FileText block={f()} />}</Match>
            <Match when={textOf(block())}>{(text) => <p class={styles.previewProse}>{text()}</p>}</Match>
          </Switch>
        )}
      </Show>
    </Dialog>
  );
}

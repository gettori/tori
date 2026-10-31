import { createSignal } from "solid-js";
import { ATTACHMENT_KINDS, attachmentLabel, checkAttachment, type AttachmentKind } from "../../src/utils/chatCompose";
import type { RemoteClient } from "./remote";

const UPLOAD_MAX = 8 * 1024 * 1024;
// Raw bytes per chunk: base64 of this is the daemon's 192 KB chunk limit.
const CHUNK = 144 * 1024;
const LONG_EDGE = 2048;

export type Attached = { id: number; name: string; kind: AttachmentKind; path: string | null };

// The daemon numbers a steer's files per kind from 1, in the order sent.
export function labels(files: readonly Pick<Attached, "kind">[]): string[] {
  const counts: Partial<Record<AttachmentKind, number>> = {};
  return files.map((f) => {
    const n = (counts[f.kind] ?? 0) + 1;
    counts[f.kind] = n;
    return attachmentLabel(f.kind, n);
  });
}

function megabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

// A camera photo is 10 MB or more, past what one upload takes.
async function downscaled(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = LONG_EDGE / Math.max(bitmap.width, bitmap.height);
  if (scale >= 1) {
    bitmap.close();
    return file;
  }
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    return file;
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  const stem = file.name.replace(/\.[^.]*$/, "") || "photo";
  return new File([blob], `${stem}.jpg`, { type: "image/jpeg" });
}

async function prepare(
  file: File,
  pending: number,
): Promise<{ ok: true; file: File; kind: AttachmentKind } | { ok: false; reason: string }> {
  const sent = file.type.startsWith("image/") ? await downscaled(file) : file;
  if (sent.size > UPLOAD_MAX) {
    return {
      ok: false,
      reason: `${file.name} is ${megabytes(sent.size)}MB. The phone sends files up to ${UPLOAD_MAX / 1024 / 1024}MB.`,
    };
  }
  const check = checkAttachment({ name: sent.name, mediaType: sent.type, bytes: sent.size }, pending, {
    kinds: ATTACHMENT_KINDS,
    gap: null,
  });
  return check.ok ? { ok: true, file: sent, kind: check.kind } : check;
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

// Null when dropped mid-way: the daemon forgets an upload left unfinished.
async function upload(client: RemoteClient, file: File, dropped: () => boolean): Promise<string | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let id: string | undefined;
  for (let at = 0; ; at += CHUNK) {
    if (dropped()) return null;
    const last = at + CHUNK >= bytes.length;
    const data = base64(bytes.subarray(at, at + CHUNK));
    const done = await client.request<{ upload?: string; path?: string }>("attachment.write", {
      name: file.name,
      data,
      upload: id,
      last,
    });
    if (last) {
      if (!done.path) throw new Error(`Tori stored ${file.name} but named no path for it`);
      return done.path;
    }
    id = done.upload;
  }
}

export function createAttachments(client: RemoteClient, onError: (message: string) => void) {
  const [files, setFiles] = createSignal<Attached[]>([]);
  let next = 0;
  let preparing = 0;
  const add = async (picked: readonly File[]) => {
    for (const raw of picked) {
      preparing += 1;
      const ready = await prepare(raw, files().length + preparing - 1).finally(() => (preparing -= 1));
      if (!ready.ok) {
        onError(ready.reason);
        continue;
      }
      const id = ++next;
      setFiles((f) => [...f, { id, name: ready.file.name, kind: ready.kind, path: null }]);
      try {
        const path = await upload(client, ready.file, () => !files().some((a) => a.id === id));
        if (path) setFiles((f) => f.map((a) => (a.id === id ? { ...a, path } : a)));
      } catch (e) {
        setFiles((f) => f.filter((a) => a.id !== id));
        onError(String(e instanceof Error ? e.message : e));
      }
    }
  };
  return {
    files,
    add,
    remove: (id: number) => setFiles((f) => f.filter((a) => a.id !== id)),
    clear: () => setFiles([]),
    uploading: () => files().some((a) => a.path === null),
    paths: () => files().flatMap((a) => (a.path ? [a.path] : [])),
  };
}

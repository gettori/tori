import { createSignal, type Accessor } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type SizeChoice<Id extends string> = { id: Id; label: string; description: string };

export type Progress<Id extends string> = { size: Id; done: number; total: number };

export type DownloadStatus<Id extends string> = {
  installed: boolean;
  model: Id | null;
  downloading: Progress<Id> | null;
  sizes: { id: Id; bytes: number }[];
};

type DownloadEvent<Id extends string> =
  | ({ kind: "progress" } & Progress<Id>)
  | { kind: "done"; size: Id }
  | { kind: "cancel" }
  | { kind: "error"; error: string };

export type DownloadStore<Id extends string, Status extends DownloadStatus<Id>> = {
  sizes: SizeChoice<Id>[];
  status: Accessor<Status>;
  asking: Accessor<boolean>;
  failed: Accessor<string | null>;
  refresh: () => Promise<void>;
  askToDownload: (then?: (() => void) | null) => void;
  dismissAsk: () => void;
  dropPending: () => void;
  download: (size: Id) => Promise<void>;
  cancelDownload: () => Promise<unknown>;
  remove: () => Promise<void>;
  sizeLabel: (id: Id) => string;
};

export const mb = (bytes: number) => Math.round(bytes / 1e6);

export function createDownload<Id extends string, Status extends DownloadStatus<Id>>(opts: {
  command: string;
  event: string;
  sizes: SizeChoice<Id>[];
  empty: Status;
}): DownloadStore<Id, Status> {
  const [status, setStatus] = createSignal<Status>(opts.empty);
  const [asking, setAsking] = createSignal(false);
  const [failed, setFailed] = createSignal<string | null>(null);

  let pending: (() => void) | null = null;
  let listening: Promise<unknown> | null = null;

  function heard(e: DownloadEvent<Id>) {
    if (e.kind === "progress") {
      setStatus((s) => ({ ...s, downloading: { size: e.size, done: e.done, total: e.total } }));
      return;
    }
    setStatus((s) => ({ ...s, downloading: null }));
    if (e.kind === "error") setFailed(e.error);
    void refresh().catch((err) => setFailed(String(err)));
    if (e.kind !== "done") return;
    const then = pending;
    pending = null;
    setAsking(false);
    then?.();
  }

  function watch() {
    listening ??= listen<DownloadEvent<Id>>(opts.event, (e) => heard(e.payload)).catch((e) => {
      listening = null;
      throw e;
    });
    return listening;
  }

  async function refresh(): Promise<void> {
    await watch();
    const fresh = await invoke<Status>(`${opts.command}_status`);
    setStatus(() => fresh);
  }

  function askToDownload(then: (() => void) | null = null): void {
    pending = then;
    setFailed(null);
    setAsking(true);
    void refresh().catch((e) => setFailed(String(e)));
  }

  function dismissAsk(): void {
    pending = null;
    setAsking(false);
  }

  async function download(size: Id): Promise<void> {
    setFailed(null);
    try {
      await watch();
      await invoke(`${opts.command}_download`, { size });
      await refresh();
    } catch (e) {
      setFailed(String(e));
    }
  }

  function sizeLabel(id: Id): string {
    const size = opts.sizes.find((s) => s.id === id)!;
    const bytes = status().sizes.find((s) => s.id === id)?.bytes;
    return bytes ? `${size.label}, ${mb(bytes)} MB` : size.label;
  }

  return {
    sizes: opts.sizes,
    status,
    asking,
    failed,
    refresh,
    askToDownload,
    dismissAsk,
    dropPending: () => {
      pending = null;
    },
    download,
    cancelDownload: () => invoke(`${opts.command}_download_cancel`),
    remove: async () => {
      await invoke(`${opts.command}_delete`);
      await refresh();
    },
    sizeLabel,
  };
}

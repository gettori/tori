import { Show, createSignal, type Accessor } from "solid-js";
import Icon from "../../src/components/Icon/Icon";
import { fallbackIcon, resolveIcon } from "../../src/components/Icon/iconRegistry";
import type { RemoteClient } from "./remote";
import type { Project } from "./tree";
import styles from "./shell.module.css";

type Kept = { version: string; url: string };
type Sent = { version: string; mime: string; data: string } | null;

const DB_NAME = "tori-mobile";
const STORE = "projectIcons";

let db: Promise<IDBDatabase> | undefined;

function openDb() {
  db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return db;
}

async function read(path: string): Promise<Kept | undefined> {
  const store = (await openDb()).transaction(STORE).objectStore(STORE);
  return new Promise((resolve, reject) => {
    const req = store.get(path);
    req.onsuccess = () => resolve(req.result as Kept | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function write(path: string, kept: Kept) {
  (await openDb()).transaction(STORE, "readwrite").objectStore(STORE).put(kept, path);
}

const images = new Map<string, Accessor<string | undefined>>();

// Asked for only once a row showing the project is drawn, and kept on the phone
// until the Mac reports a different version.
function projectImage(client: RemoteClient, path: string, version: string): Accessor<string | undefined> {
  const key = `${path}\n${version}`;
  const known = images.get(key);
  if (known) return known;
  const [url, setUrl] = createSignal<string>();
  images.set(key, url);
  void (async () => {
    const kept = await read(path).catch(() => undefined);
    if (kept?.version === version) return setUrl(kept.url);
    const sent = await client.request<Sent>("project.icon", { path }).catch(() => undefined);
    if (sent === undefined) return images.delete(key);
    if (!sent) return;
    const data = `data:${sent.mime};base64,${sent.data}`;
    setUrl(data);
    await write(path, { version: sent.version, url: data }).catch(() => {});
  })();
  return url;
}

/** The project's mark in the order the desktop sidebar uses: its image, a picked glyph, then one derived from the path. */
export function ProjectMark(props: { client: RemoteClient; project: Project; big?: boolean }) {
  const image = () =>
    props.project.image ? projectImage(props.client, props.project.path, props.project.image)() : undefined;
  const size = () => (props.big ? 24 : 19);
  return (
    <span class={props.big ? `${styles.tile} ${styles.bigTile}` : styles.tile}>
      <Show
        when={image()}
        fallback={
          <Icon
            icon={resolveIcon(props.project.icon) ?? fallbackIcon(props.project.path)}
            size={size()}
            strokeWidth={1.9}
          />
        }
      >
        {(src) => (
          <img
            class={styles.tileImage}
            src={src()}
            alt=""
            style={{ width: `${size() + 4}px`, height: `${size() + 4}px` }}
          />
        )}
      </Show>
    </span>
  );
}

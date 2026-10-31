import { For, Show, createSignal, type JSX } from "solid-js";
import { ChevronDown, ChevronUp } from "lucide-solid";
import Icon from "../../src/components/Icon/Icon";
import { PICKER_ICONS, resolveIcon } from "../../src/components/Icon/iconRegistry";
import { SPACE_COLORS, spaceHueRgb } from "../../src/utils/spaceTint";
import { spaceInitials } from "../../src/utils/names";
import type { RemoteClient } from "./remote";
import type { Project, Space } from "./tree";
import styles from "./shell.module.css";

const ICON_SHELF = 18;

function Sheet(props: {
  title: string;
  action?: { label: string; busy: boolean; disabled?: boolean; run: () => void };
  error: string | null;
  onDone: () => void;
  children: JSX.Element;
}) {
  return (
    <>
      <div class={styles.dim} onClick={() => props.onDone()} />
      <section class={styles.sheet} role="dialog" aria-label={props.title}>
        <span class={styles.grabber} />
        <header class={styles.sheetHead}>
          <span class={styles.sheetTitle}>{props.title}</span>
          <Show
            when={props.action}
            fallback={
              <button class={styles.done} onClick={() => props.onDone()}>
                Done
              </button>
            }
          >
            {(action) => (
              <button class={styles.done} disabled={action().busy || action().disabled} onClick={() => action().run()}>
                {action().busy ? "Saving" : action().label}
              </button>
            )}
          </Show>
        </header>
        <div class={styles.sheetBody}>
          <Show when={props.error}>
            <p class={styles.banner}>{props.error}</p>
          </Show>
          {props.children}
        </div>
      </section>
    </>
  );
}

async function attempt(setBusy: (b: boolean) => void, setError: (e: string | null) => void, work: () => Promise<void>) {
  setBusy(true);
  setError(null);
  try {
    await work();
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  } finally {
    setBusy(false);
  }
}

function SpaceForm(props: { client: RemoteClient; space: Space | null; onSaved: () => void; onDone: () => void }) {
  const [name, setName] = createSignal(props.space?.name ?? "");
  const [color, setColor] = createSignal<string | null>(props.space?.color ?? null);
  const [icon, setIcon] = createSignal<string | null>(props.space?.icon ?? null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const current = PICKER_ICONS.find((i) => i.name === props.space?.icon);
  const shelf = [...(current ? [current] : []), ...PICKER_ICONS.filter((i) => i !== current)].slice(0, ICON_SHELF);
  const save = () =>
    attempt(setBusy, setError, async () => {
      const params = { name: name().trim(), icon: icon(), color: color() };
      await props.client.request(props.space ? "space.edit" : "space.new", params);
      props.onSaved();
      props.onDone();
    });
  const tint = () => spaceHueRgb(name() || "space", color());
  return (
    <Sheet
      title={props.space ? `Edit ${props.space.name}` : "New space"}
      action={{
        label: props.space ? "Save" : "Create",
        busy: busy(),
        disabled: !name().trim(),
        run: () => void save(),
      }}
      error={error()}
      onDone={props.onDone}
    >
      <Show when={!props.space}>
        <div class={styles.typedBody}>
          <label class={styles.field}>
            Name
            <input value={name()} onInput={(e) => setName(e.currentTarget.value)} />
          </label>
        </div>
      </Show>
      <h2 class={styles.label}>Colour</h2>
      <div class={styles.swatches}>
        <button class={styles.swatch} aria-pressed={color() === null} onClick={() => setColor(null)}>
          Auto
        </button>
        <For each={SPACE_COLORS}>
          {(c) => (
            <button
              class={styles.swatch}
              aria-label={c.name}
              aria-pressed={color() === c.name}
              style={{ background: c.hex }}
              onClick={() => setColor(c.name)}
            />
          )}
        </For>
      </div>
      <h2 class={styles.label}>Icon</h2>
      <div class={styles.swatches} style={{ "--tint": tint() }}>
        <button class={styles.swatch} aria-pressed={icon() === null} onClick={() => setIcon(null)}>
          {spaceInitials(name() || "?")}
        </button>
        <For each={shelf}>
          {(i) => (
            <button
              class={styles.swatch}
              aria-label={i.name}
              aria-pressed={icon() === i.name}
              onClick={() => setIcon(i.name)}
            >
              <Icon icon={i.icon} size={18} strokeWidth={2} />
            </button>
          )}
        </For>
      </div>
    </Sheet>
  );
}

export function SpacesSheet(props: {
  client: RemoteClient;
  spaces: Space[];
  onChanged: () => void;
  onDone: () => void;
}) {
  const [editing, setEditing] = createSignal<Space | "new" | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const move = (at: number, by: number) =>
    attempt(setBusy, setError, async () => {
      const names = props.spaces.map((s) => s.name);
      [names[at], names[at + by]] = [names[at + by], names[at]];
      await props.client.request("space.order", { names });
      props.onChanged();
    });
  return (
    <Show
      when={editing()}
      fallback={
        <Sheet title="Spaces" error={error()} onDone={props.onDone}>
          <ul class={styles.group}>
            <For each={props.spaces}>
              {(space, i) => (
                <li>
                  <div class={`${styles.item} ${styles.setting}`}>
                    <span class={styles.text}>
                      <Show when={resolveIcon(space.icon)}>{(glyph) => <Icon icon={glyph()} size={15} />}</Show>{" "}
                      {space.name}
                    </span>
                    <button
                      class={styles.more}
                      aria-label={`Move ${space.name} up`}
                      disabled={busy() || i() === 0}
                      onClick={() => void move(i(), -1)}
                    >
                      <Icon icon={ChevronUp} size={18} />
                    </button>
                    <button
                      class={styles.more}
                      aria-label={`Move ${space.name} down`}
                      disabled={busy() || i() === props.spaces.length - 1}
                      onClick={() => void move(i(), 1)}
                    >
                      <Icon icon={ChevronDown} size={18} />
                    </button>
                    <button class={styles.value} onClick={() => setEditing(space)}>
                      Edit
                    </button>
                  </div>
                </li>
              )}
            </For>
            <li>
              <button class={`${styles.item} ${styles.setting}`} onClick={() => setEditing("new")}>
                <span class={styles.text}>New space</span>
              </button>
            </li>
          </ul>
          <p class={styles.footnote}>Deleting a space removes its folder, so it stays on the Mac.</p>
        </Sheet>
      }
    >
      {(open) => (
        <SpaceForm
          client={props.client}
          space={open() === "new" ? null : (open() as Space)}
          onSaved={props.onChanged}
          onDone={() => setEditing(null)}
        />
      )}
    </Show>
  );
}

export type Choice = { label: string; meta?: string; value: string };

export function ChoiceSheet(props: {
  title: string;
  message?: string;
  choices: Choice[];
  onPick: (value: string) => Promise<unknown>;
  onDone: () => void;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  return (
    <Sheet title={props.title} error={error()} onDone={props.onDone}>
      <Show when={props.message}>
        <p class={styles.footnote}>{props.message}</p>
      </Show>
      <ul class={styles.group}>
        <For each={props.choices} fallback={<li class={styles.empty}>Nothing to pick</li>}>
          {(choice) => (
            <li>
              <button
                class={styles.item}
                disabled={busy()}
                onClick={() =>
                  void attempt(setBusy, setError, async () => {
                    await props.onPick(choice.value);
                    props.onDone();
                  })
                }
              >
                <span class={styles.text}>
                  <span class={styles.name}>{choice.label}</span>
                  <Show when={choice.meta}>
                    <span class={styles.meta}>{choice.meta}</span>
                  </Show>
                </span>
              </button>
            </li>
          )}
        </For>
      </ul>
    </Sheet>
  );
}

type Mode = "worktree" | "reference";

export function TopicForm(props: {
  client: RemoteClient;
  projects: Project[];
  onSaved: () => void;
  onDone: () => void;
}) {
  const [name, setName] = createSignal("");
  const [branch, setBranch] = createSignal("");
  const [picked, setPicked] = createSignal<Record<string, Mode>>({});
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const toggle = (path: string, mode: Mode | null) =>
    setPicked((prev) => {
      const next = { ...prev };
      if (mode) next[path] = mode;
      else delete next[path];
      return next;
    });
  const members = () => Object.entries(picked()).map(([repoPath, mode]) => ({ repoPath, mode }));
  const needsBranch = () => members().some((m) => m.mode === "worktree");
  const ready = () => name().trim() !== "" && members().length > 0 && (!needsBranch() || branch().trim() !== "");
  const save = () =>
    attempt(setBusy, setError, async () => {
      await props.client.request("topic.new", { name: name().trim(), branch: branch().trim(), members: members() });
      props.onSaved();
      props.onDone();
    });
  return (
    <Sheet
      title="New Topic"
      action={{ label: "Create Topic", busy: busy(), disabled: !ready(), run: () => void save() }}
      error={error()}
      onDone={props.onDone}
    >
      <div class={styles.typedBody}>
        <label class={styles.field}>
          Name
          <input value={name()} onInput={(e) => setName(e.currentTarget.value)} />
        </label>
        <label class={styles.field}>
          Branch
          <input class={styles.mono} value={branch()} onInput={(e) => setBranch(e.currentTarget.value)} />
        </label>
      </div>
      <h2 class={styles.label}>Repositories</h2>
      <ul class={styles.group}>
        <For each={props.projects}>
          {(project) => (
            <li>
              <div class={`${styles.item} ${styles.setting}`}>
                <span class={styles.text}>{project.name}</span>
                <span class={styles.segments}>
                  <button aria-pressed={!picked()[project.path]} onClick={() => toggle(project.path, null)}>
                    Off
                  </button>
                  <button
                    aria-pressed={picked()[project.path] === "worktree"}
                    onClick={() => toggle(project.path, "worktree")}
                  >
                    Worktree
                  </button>
                  <button
                    aria-pressed={picked()[project.path] === "reference"}
                    onClick={() => toggle(project.path, "reference")}
                  >
                    Reference
                  </button>
                </span>
              </div>
            </li>
          )}
        </For>
      </ul>
      <p class={styles.footnote}>
        A worktree member gets its own worktree on the branch. Reference is read only: the repository's own checkout.
      </p>
    </Sheet>
  );
}

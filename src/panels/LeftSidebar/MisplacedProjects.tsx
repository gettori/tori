import { createSignal, For, Show } from "solid-js";
import { FolderInput } from "lucide-solid";
import Button from "../../components/Button/Button";
import Chevron from "../../components/Chevron/Chevron";
import Icon from "../../components/Icon/Icon";
import { shortHome } from "../../utils/names";
import styles from "./MisplacedProjects.module.css";

// Discovery no longer reads a project at the top of the base folder as a
// space, so without this an upgrade would make it vanish from the sidebar.
export default function MisplacedProjects(props: { paths: string[]; home: string; onAttach: (path: string) => void }) {
  const [open, setOpen] = createSignal(false);
  const name = (path: string) => path.split("/").pop() || path;
  const count = () => props.paths.length;

  return (
    <Show when={count() > 0}>
      <div class={styles.misplaced}>
        <button type="button" class={styles.head} aria-expanded={open()} onClick={() => setOpen(!open())}>
          <Chevron open={open()} />
          <span>
            {count()} {count() === 1 ? "project isn't" : "projects aren't"} in a space
          </span>
        </button>
        <Show when={open()}>
          <p class={styles.note}>Attach one to Home to use it where it is.</p>
          <For each={props.paths}>
            {(path) => (
              <div class={styles.row}>
                <span class={styles.name} title={shortHome(path, props.home)}>
                  {name(path)}
                </span>
                <Button size="sm" icon={<Icon icon={FolderInput} />} onClick={() => props.onAttach(path)}>
                  Attach to Home
                </Button>
              </div>
            )}
          </For>
        </Show>
      </div>
    </Show>
  );
}

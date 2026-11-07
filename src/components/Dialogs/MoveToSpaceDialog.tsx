import { createSignal } from "solid-js";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import Select from "../Select/Select";
import { createMoveForm, MoveFields } from "./MoveIntoSpace";
import styles from "./Dialogs.module.css";

export default function MoveToSpaceDialog(props: {
  name: string;
  path: string;
  base: string;
  home: string;
  spaces: string[];
  countRunning: (path: string) => Promise<number>;
  onMoved: (to: string, warnings: string[]) => void;
  onCancel: () => void;
}) {
  const [space, setSpace] = createSignal(props.spaces[0] ?? "");
  const form = createMoveForm({
    path: () => props.path,
    base: () => props.base,
    space,
    countRunning: props.countRunning,
  });

  async function move() {
    const done = await form.submit();
    if (done) props.onMoved(done.to, done.warnings);
  }

  return (
    <Dialog
      open
      size="sheet"
      title={`Move “${props.name}” to a space`}
      onClose={() => props.onCancel()}
      onKeyDown={(e) => {
        if (e.key === "Enter" && form.canMove()) {
          e.preventDefault();
          void move();
        }
      }}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button variant="primary" disabled={!form.canMove()} onClick={() => void move()}>
            {form.busy() ? "Moving…" : "Move"}
          </Button>
        </>
      }
    >
      <div class={styles.spaceForm}>
        <div class={styles.spaceField}>
          <div class={styles.spaceLabel}>Space</div>
          <Select
            class={styles.fullWidth}
            aria-label="Space"
            options={props.spaces.map((s) => ({ value: s, label: s }))}
            value={space()}
            onChange={setSpace}
          />
        </div>
        <MoveFields form={form} path={props.path} home={props.home} />
      </div>
    </Dialog>
  );
}

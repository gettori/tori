import { createMemo, type Accessor } from "solid-js";

export type ListOption = { value: string; label: string; disabled?: boolean };
export type ListGroup<O extends ListOption> = { label: string; options: O[] };
export type ListRow<O extends ListOption> = { kind: "section"; group: ListGroup<O> } | { kind: "option"; option: O };

const OPTION_PREFIX = "option:";

export const optionKey = (value: string) => `${OPTION_PREFIX}${value}`;
export const valueOfKey = (key: string) =>
  key.startsWith(OPTION_PREFIX) ? key.slice(OPTION_PREFIX.length) : undefined;

// Headings key by position because two groups may share a label.
export function createListRows<O extends ListOption>(entries: Accessor<readonly (O | ListGroup<O>)[]>) {
  const rows = createMemo(() => {
    const byKey = new Map<string, ListRow<O>>();
    let sections = 0;
    for (const entry of entries()) {
      if ("options" in entry) {
        byKey.set(`section:${sections++}`, { kind: "section", group: entry });
        for (const option of entry.options) byKey.set(optionKey(option.value), { kind: "option", option });
      } else {
        byKey.set(optionKey(entry.value), { kind: "option", option: entry });
      }
    }
    return byKey;
  });
  const keys = createMemo(() => [...rows().keys()]);
  const options = createMemo(() => [...rows().values()].flatMap((row) => (row.kind === "option" ? [row.option] : [])));
  return { keys, options, row: (key: string) => rows().get(key) };
}

/** How many items a sidebar group lists before the rest fold away. */
export const GROUP_CAP = 6;

/** Cut a list to its first `cap` items, keeping every item `keep` asks for in
 *  its own place past the cap. Both halves keep the list's order, so a kept
 *  item never jumps to the top and the hidden ones read back in sequence. */
export function capList<T>(items: readonly T[], cap: number, keep: (item: T) => boolean): { shown: T[]; hidden: T[] } {
  const shown: T[] = [];
  const hidden: T[] = [];
  for (const [i, item] of items.entries()) {
    if (i < cap || keep(item)) shown.push(item);
    else hidden.push(item);
  }
  return { shown, hidden };
}

/** "1 more branch", "4 more chats": the label a fold row wears while it hides. */
export const moreLabel = (count: number, noun: readonly [one: string, many: string]) =>
  `${count} more ${count === 1 ? noun[0] : noun[1]}`;

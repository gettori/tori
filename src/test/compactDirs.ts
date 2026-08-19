/** Test double for the backend's `fs_read_dir_compact`, computed over a
 *  suite's `dirs` fixture map. Mirrors the command's semantics (single-child
 *  chains collapse, never into an ignored dir, hidden names out of the child
 *  count) but takes `ignored` from the fixture entries where the real command
 *  asks `git check-ignore`. Fixture order is preserved: the old per-dir mock
 *  never sorted either, and suites assert against their own ordering. */

type Entry = { name: string; path: string; is_dir: boolean; ignored: boolean };
export type CompactRow = Entry & { label: string };

export function compactRows(
  dirs: Record<string, Entry[]>,
  args: { path: string; compact: boolean; hidden: string[] },
): CompactRow[] {
  const hidden = new Set(args.hidden);
  const kidsOf = (p: string) => (dirs[p] ?? []).filter((e) => !hidden.has(e.name));
  return kidsOf(args.path).map((e) => {
    let label = e.name;
    let deep = e;
    if (args.compact && e.is_dir && !e.ignored) {
      for (let i = 0; i < 8; i++) {
        const kids = kidsOf(deep.path);
        if (kids.length !== 1 || !kids[0].is_dir || kids[0].ignored) break;
        deep = kids[0];
        label = `${label}/${deep.name}`;
      }
    }
    return { name: deep.name, path: deep.path, is_dir: e.is_dir, ignored: e.ignored, label };
  });
}

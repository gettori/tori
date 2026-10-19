import { appChain, inLibrary, type Components } from "./components";

type Loc = { file?: string; line?: number };
type Parent = { type?: string; file?: string; componentTag?: string; parent?: Parent | null };
type Meta = { loc?: Loc; parent?: Parent | null };

const base = (file: string) =>
  file
    .split("/")
    .pop()
    ?.replace(/\.\w+$/, "") ?? "";

// A Svelte dev build marks each element with where it is written, and each
// component parent with the file that used it. A component's own file is therefore
// the file the level below was written in, and the root's is the last file used.
export function svelteComponents(node: Node): Components | null {
  const meta = (node as { __svelte_meta?: Meta }).__svelte_meta;
  const file = meta?.loc?.file;
  if (!file) return null;
  const steps = [{ name: base(file), library: inLibrary(file) }];
  let below = file;
  for (let at = meta.parent; at; at = at.parent) {
    if (at.type !== "component" || !at.file) continue;
    steps[steps.length - 1] = { name: at.componentTag || steps[steps.length - 1].name, library: inLibrary(below) };
    steps.push({ name: base(at.file), library: inLibrary(at.file) });
    below = at.file;
  }
  return {
    chain: appChain(steps) ?? [],
    props: null,
    source: meta.loc?.line ? `${file}:${meta.loc.line}` : file,
  };
}

import { appChain, inLibrary, shallowProps, type Components } from "./components";

type Instance = {
  type?: { name?: string; __name?: string; __file?: string };
  props?: Record<string, unknown>;
  parent?: Instance | null;
};

const base = (file: string) =>
  file
    .split("/")
    .pop()
    ?.replace(/\.\w+$/, "") ?? "";

// Vue 3 puts the owning component on each element it renders, as a non enumerable property.
export function vueComponents(node: Node, sensitive: boolean): Components | null {
  const first = (node as { __vueParentComponent?: Instance }).__vueParentComponent;
  if (!first) return null;
  const steps = [];
  for (let at: Instance | null | undefined = first; at; at = at.parent) {
    const file = at.type?.__file;
    steps.push({
      name: at.type?.name || at.type?.__name || (file ? base(file) : ""),
      library: file ? inLibrary(file) : undefined,
    });
  }
  const chain = appChain(steps);
  if (!chain) return null;
  return {
    chain,
    props: first.props ? shallowProps(first.props, sensitive) : null,
    source: first.type?.__file ?? null,
  };
}

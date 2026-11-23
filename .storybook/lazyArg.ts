import type { JSX } from "@solidjs/web";

// Story args are built at module load, where no owner exists and a component
// reading context throws. A function child renders later, under the story.
export const lazyArg = (view: () => JSX.Element) => view as unknown as JSX.Element;

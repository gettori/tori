// Trailing-edge debounce: delays invoking `fn` until `ms` have passed with no
// further calls.
//
// `cancel` drops a pending call, and a component that owns a debounced side
// effect should call it from `onCleanup`. Without that, the last thing typed
// into a panel still reaches the backend a fifth of a second after the panel is
// gone: the work is wasted, and the result is applied to signals nothing reads.
// It is also visible from outside, which is how this was found - a pending
// search outliving the SearchPanel that queued it landed in the next test's
// bridge and made it click Replace all before its own results existed.
export type Debounced<A extends unknown[]> = ((...args: A) => void) & {
  cancel: () => void;
};

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  run.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return run;
}

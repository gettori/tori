import { createEffect, createSignal, onCleanup, untrack, type Accessor } from "solid-js";

export type FetchPhase = "unresolved" | "pending" | "ready" | "refreshing" | "errored";

export type FetchInfo<T> = { value: T | undefined; refetching: unknown };

export type FetchValue<T> = Accessor<T> & {
  readonly loading: boolean;
  readonly error: unknown;
  readonly state: FetchPhase;
  readonly latest: T;
};

export type FetchActions<T> = {
  refetch: (info?: unknown) => Promise<T | undefined> | undefined;
  mutate: (next: T | ((prev: T) => T)) => T;
};

type Source<S> = () => S | null | undefined | false;
type Fetcher<S, T> = (source: S, info: FetchInfo<T>) => T | Promise<T>;
type Options<T> = { initialValue?: T };

const isThenable = <T>(value: T | Promise<T>): value is Promise<T> =>
  typeof (value as Promise<T> | null | undefined)?.then === "function";

// For the resources whose callers read `.loading`, `.error` or `.state`, or use
// `mutate`, which no async memo form reproduces. A rejection lands in `.error`
// instead of halting the reactive system. #109 removes this.
export function createFetchState<T>(
  fetcher: Fetcher<true, T>,
  options: Options<T> & { initialValue: T },
): [FetchValue<T>, FetchActions<T>];
export function createFetchState<T>(
  fetcher: Fetcher<true, T>,
  options?: Options<T>,
): [FetchValue<T | undefined>, FetchActions<T | undefined>];
export function createFetchState<S, T>(
  source: Source<S>,
  fetcher: Fetcher<S, T>,
  options: Options<T> & { initialValue: T },
): [FetchValue<T>, FetchActions<T>];
export function createFetchState<S, T>(
  source: Source<S>,
  fetcher: Fetcher<S, T>,
  options?: Options<T>,
): [FetchValue<T | undefined>, FetchActions<T | undefined>];
export function createFetchState<S, T>(
  ...args: [Fetcher<S, T>, Options<T>?] | [Source<S>, Fetcher<S, T>, Options<T>?]
): [FetchValue<T | undefined>, FetchActions<T | undefined>] {
  const hasSource = typeof args[1] === "function";
  const source = (hasSource ? args[0] : () => true) as Source<S>;
  const fetcher = (hasSource ? args[1] : args[0]) as Fetcher<S, T>;
  const options = ((hasSource ? args[2] : args[1]) ?? {}) as Options<T>;

  const isLookup = (lookup: S | null | undefined | false): lookup is S => lookup != null && lookup !== false;
  let resolved = "initialValue" in options;
  let latest = options.initialValue;
  const [value, setValue] = createSignal<{ current: T | undefined }>({ current: options.initialValue });
  const [error, setError] = createSignal<{ current: unknown }>({ current: undefined });
  const [phase, setPhase] = createSignal<FetchPhase>(
    isLookup(untrack(source)) ? (resolved ? "refreshing" : "pending") : resolved ? "ready" : "unresolved",
  );

  let run = 0;
  onCleanup(() => run++);

  const land = (mine: number, next: T) => {
    if (mine !== run) return next;
    resolved = true;
    latest = next;
    setValue({ current: next });
    setError({ current: undefined });
    setPhase("ready");
    return next;
  };
  const fail = (mine: number, err: unknown) => {
    if (mine !== run) return undefined;
    setError({ current: err });
    setPhase("errored");
    return undefined;
  };

  const load = (lookup: S | null | undefined | false, refetching: unknown) => {
    const mine = ++run;
    if (!isLookup(lookup)) {
      setPhase(resolved ? "ready" : "unresolved");
      return undefined;
    }
    let result: T | Promise<T>;
    try {
      result = fetcher(lookup, { value: latest, refetching });
    } catch (err) {
      return fail(mine, err);
    }
    if (!isThenable(result)) return Promise.resolve(land(mine, result));
    setPhase(resolved ? "refreshing" : "pending");
    return result.then(
      (next) => land(mine, next),
      (err) => fail(mine, err),
    );
  };

  createEffect(source, (lookup) => {
    void load(lookup, false);
  });

  const read = (() => value().current) as FetchValue<T | undefined>;
  Object.defineProperties(read, {
    loading: { get: () => phase() === "pending" || phase() === "refreshing" },
    error: { get: () => error().current },
    state: { get: phase },
    latest: { get: () => value().current },
  });

  return [
    read,
    {
      refetch: (info = true) => load(untrack(source), info),
      mutate: (next) => {
        latest = typeof next === "function" ? (next as (prev: T | undefined) => T | undefined)(latest) : next;
        setValue({ current: latest });
        return latest;
      },
    },
  ];
}

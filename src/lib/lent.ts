import { createSignal, type Accessor } from "solid-js";

// Readers call through to the lent accessor: copied across in an effect, every
// reader would see the value one flush late.
export function createLent<T>(initial: T): {
  read: Accessor<T>;
  set: (value: T) => void;
  lend: (source: Accessor<T>) => () => void;
} {
  // Outside the signal, so a `set` while something is lent wakes no reader.
  let own = initial;
  const [lent, setLent] = createSignal<{ source: Accessor<T> | null }>({ source: null });
  return {
    read: () => {
      const { source } = lent();
      return source ? source() : own;
    },
    set: (value) => {
      own = value;
      setLent((s) => (s.source ? s : { source: null }));
    },
    lend: (source) => {
      setLent({ source });
      return () => setLent((s) => (s.source === source ? { source: null } : s));
    },
  };
}

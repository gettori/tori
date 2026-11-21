export interface Mounted {
  container: HTMLElement;
  unmount: () => void;
}

export const mounted = new Set<Mounted>();

export function cleanup() {
  for (const { container, unmount } of mounted) {
    unmount();
    container.remove();
  }
  mounted.clear();
}

import { onCleanup } from "solid-js";
import { describe, expect, it, vi } from "vite-plus/test";
import { cleanup, render } from "./harness";

describe("the test harness", () => {
  it("runs onCleanup on unmount, once", () => {
    const disposed = vi.fn();
    const { unmount } = render(() => {
      onCleanup(disposed);
      return <p>mounted</p>;
    });

    unmount();
    unmount();

    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it("empties the document on cleanup", () => {
    const disposed = vi.fn();
    render(() => {
      onCleanup(disposed);
      return <p>mounted</p>;
    });

    cleanup();

    expect(disposed).toHaveBeenCalledTimes(1);
    expect(document.body.childElementCount).toBe(0);
  });

  it("binds its queries to the container", () => {
    render(() => <p>other</p>);
    const { container, getByText, queryByText } = render(() => <p>mine</p>);

    expect(container.contains(getByText("mine"))).toBe(true);
    expect(queryByText("other")).toBeNull();
  });
});

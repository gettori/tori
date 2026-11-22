import { createSignal, OBSERVE } from "solid-js";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { cleanup, render } from "../test/harness";

afterEach(cleanup);

it("reports a warn level diagnostic on both channels", () => {
  const seen: string[] = [];
  const stop = OBSERVE!.diagnostics.subscribe((entry: { code: string; severity: string }) => {
    seen.push(`${entry.severity}:${entry.code}`);
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const [count] = createSignal(1);
  function Frozen(props: { value: number }) {
    const frozen = props.value;
    const direct = count();
    return (
      <p>
        {frozen}
        {direct}
      </p>
    );
  }
  render(() => <Frozen value={count()} />);
  stop();
  expect(seen).toEqual(["warn:STRICT_READ_UNTRACKED", "warn:STRICT_READ_UNTRACKED"]);
  expect(warn).toHaveBeenCalledTimes(2);
  expect(error).not.toHaveBeenCalled();
});

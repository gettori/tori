import { describe, expect, it } from "vite-plus/test";
import { render } from "@solidjs/testing-library";
import AutopilotView from "./AutopilotView";
import { VIEW } from "./shellFixtures";
import type { SessionUsage } from "../../utils/chatUsageStore";

const withSpend = (spend: SessionUsage | null) => {
  const props = VIEW.working;
  return { ...props, workers: [{ ...props.workers[0], spend }] };
};

describe("a worker card's spend", () => {
  it("shows dollars beside the branch", () => {
    const { container } = render(() => <AutopilotView {...withSpend({ tokens: 9, costUsd: 2.25, turns: 3 })} />);
    expect(container.querySelector("[data-spend]")?.textContent).toBe("$2.25");
  });

  it("shows turns for an agent with no cost", () => {
    const { container } = render(() => <AutopilotView {...withSpend({ tokens: 0, costUsd: null, turns: 5 })} />);
    expect(container.querySelector("[data-spend]")?.textContent).toBe("5 turns");
  });

  it("shows nothing before anything is recorded", () => {
    const { container } = render(() => <AutopilotView {...withSpend(null)} />);
    expect(container.querySelector("[data-spend]")).toBeNull();
  });
});

describe("a waiting item's projection", () => {
  const withProjection = (projection: { usd?: number; samples: number }) => {
    const props = VIEW.working;
    return { ...props, queue: [{ ...props.queue[0], projection }] };
  };

  it("shows the median once enough items have finished", () => {
    const { container } = render(() => <AutopilotView {...withProjection({ usd: 3.5, samples: 6 })} />);
    expect(container.querySelector("[data-projection]")?.textContent).toBe("~$3.50");
  });

  it("says there is no history yet below that", () => {
    const { container } = render(() => <AutopilotView {...withProjection({ samples: 4 })} />);
    expect(container.querySelector("[data-projection]")?.textContent).toBe("no history yet");
  });
});

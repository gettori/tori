// Stage hosts (plan phase 7): one module-owned element per tab or fixed stage;
// panels render surfaces into them, panes adopt them via appendChild. Phase 1
// ruled out moving For-owned nodes, so ownership lives outside any component.
const hosts = new Map<string, HTMLElement>();

let parking: HTMLElement | undefined;

// Deliberately NOT display:none: hidden content vanishes from accessibility
// queries, and suites that mount a panel without a pane interact with its
// surface here. In the app, adoption runs in the same flush as creation.
function parkingLot(): HTMLElement {
  if (!parking) {
    parking = document.createElement("div");
    parking.dataset.stageParking = "";
    document.body.appendChild(parking);
  }
  return parking;
}

export function stageHost(id: string): HTMLElement {
  let el = hosts.get(id);
  if (!el) {
    el = document.createElement("div");
    el.dataset.stageHost = "";
    // The host (and the wrapper div Portal inserts, see App.css) is layout-
    // transparent, so the surface inside participates in the pane's own flex.
    el.style.display = "contents";
    parkingLot().appendChild(el);
    hosts.set(id, el);
  }
  return el;
}

/** On tab close: the surface inside was unmounted by its panel; the element
 *  itself would otherwise sit in its pane (or the lot) forever. */
export function dropStageHost(id: string): void {
  const el = hosts.get(id);
  if (el) {
    el.remove();
    hosts.delete(id);
  }
}

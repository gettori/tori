import { emitWith, NAVIGATE, type NavTarget, type ToastEventAction } from "./events";
import { liveProjects } from "./navIndex";

const folderName = (p: string) => p.slice(p.lastIndexOf("/") + 1) || p;

/** A checkout named the way the sidebar shows it: `branch in project`, or the
 *  folder alone while the sidebar has not placed it yet. `branch` is the one
 *  checked out right now, which on a plain repo the unit list may lag behind. */
export function placeLabel(root: string, branch?: string | null): string {
  for (const { project } of liveProjects()) {
    const unit =
      project.branchUnits.find((u) => u.folderPath === root && (u.kind !== "plain" || u.isCurrent)) ??
      project.branchUnits.find((u) => u.folderPath === root);
    if (!unit) continue;
    const name = branch ?? unit.branch ?? unit.label;
    return name && name !== project.name ? `${name} in ${project.name}` : project.name;
  }
  return branch ? `${branch} in ${folderName(root)}` : folderName(root);
}

/** The toast button that goes to the checkout the toast is about. */
export function openPlace(root: string, branch?: string | null): ToastEventAction {
  const target: NavTarget = { folder: root, ...(branch && { branch }) };
  return { label: "Open", run: () => emitWith<NavTarget>(NAVIGATE, target) };
}

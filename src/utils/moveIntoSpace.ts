import { invoke } from "@tauri-apps/api/core";
import type { ConversionPreview } from "../components/Dialogs/ConvertLayoutDialog";
import { moveProjects } from "./moveProjects";
import { moveWorkspaces } from "./moveWorkspace";
import { revokeProject, trustedNow, trustProject } from "./projectTrust";

export type MoveInto = { base: string; space: string; name: string; path: string; convert: boolean };

export type MoveOutcome = { kind: "refused"; refusal: string } | { kind: "moved"; to: string; warnings: string[] };

export const MOVE_WARNING =
  "Anything outside Tori that points at the old path stops working, and agent history stays under the old path.";

export const conversionRefusal = (path: string): Promise<string | null> =>
  invoke<ConversionPreview>("conversion_preview", { projectPath: path }).then(
    () => null,
    (e) => String(e),
  );

// Ticking Convert is the consent to trust, since the conversion runs git in
// the folder. The preview needs git too, so the source is trusted first and
// the grant taken back if the preview refuses and nothing moves.
export async function moveIntoSpace(m: MoveInto): Promise<MoveOutcome> {
  if (m.convert) {
    const granted = (await trustedNow(m.path)) ? null : await trustProject(m.path);
    const refusal = await conversionRefusal(m.path);
    if (refusal) {
      const kept = granted
        ? await revokeProject(granted).then(
            () => "",
            (e) => ` It stays trusted, since Tori couldn't take that back: ${String(e)}`,
          )
        : "";
      return { kind: "refused", refusal: refusal + kept };
    }
  }
  const done = await moveProjects(m.base, [{ space: m.space, name: m.name, path: m.path }]);
  const to = done.moves[0]?.to ?? `${m.base}/${m.space}/${m.name}`;
  const warnings = done.warning ? [done.warning] : [];
  if (!m.convert) return { kind: "moved", to, warnings };
  try {
    await trustProject(to);
    const c = await invoke<ConversionPreview>("convert_to_worktree_layout", { projectPath: to, withDefault: true });
    moveWorkspaces([{ from: to, to: `${to}/${c.leaf}` }, ...c.tori]);
    if (c.note) warnings.push(c.note);
  } catch (e) {
    warnings.push(`Moved, but the conversion didn't run: ${String(e)}`);
  }
  return { kind: "moved", to, warnings };
}

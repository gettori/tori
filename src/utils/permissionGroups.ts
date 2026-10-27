export interface PermissionRow {
  session: string;
  id: string;
  project: string | null;
  folder: string;
  agent: string;
  tool: string;
  action: string | null;
  group: string;
  autoDenyAtMs: number | null;
  rule: string | null;
}

export interface CommandGroup {
  key: string;
  rows: PermissionRow[];
}

export interface PlaceGroup {
  place: string;
  project: boolean;
  commands: CommandGroup[];
}

export function byPlace(rows: PermissionRow[]): PlaceGroup[] {
  const places = new Map<string, PlaceGroup>();
  for (const row of rows) {
    const place = row.project ?? row.folder;
    let group = places.get(place);
    if (!group) {
      group = { place, project: row.project !== null, commands: [] };
      places.set(place, group);
    }
    const command = group.commands.find((c) => c.key === row.group);
    if (command) command.rows.push(row);
    else group.commands.push({ key: row.group, rows: [row] });
  }
  return [...places.values()].sort((a, b) => Number(b.project) - Number(a.project) || a.place.localeCompare(b.place));
}

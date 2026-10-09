// Mirrors `packs::Meta` in src-tauri/src/packs/mod.rs.

export type Contributor = { name: string; github: string };

export type PackMeta = {
  description: string | null;
  contributor: Contributor | null;
  license: string | null;
};

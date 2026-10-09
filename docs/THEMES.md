# Themes

A theme is a palette: one JSON file of flat hex colours. Tori derives every
colour the interface uses from those primitives in `src/theme/roles.ts`, so a
theme file holds no expressions and no references between keys, and adding one
is a file rather than code.

This is the same shape as [LSP-SERVERS.md](LSP-SERVERS.md) describes for
language servers, with two differences: themes are JSON with camelCase keys, and
the user folder is watched, so a saved file appears without a restart.

## File location and loading

Bundled themes live in `src/theme/palettes/*.json` and are compiled into the
frontend. User themes live in `~/.config/tori/themes/*.json`.

- Every file in the user folder is checked when Tori starts and again whenever
  a `.json` file in it changes.
- A file that fails is never silently dropped: the problem is shown as an
  error toast naming the file.
- A user file may not take a bundled theme's id. Give your variant its own id.
- A file is named after its `id`: `dracula.json` holds `"id": "dracula"`. A
  file whose name and id differ still loads, with a warning naming both. An id
  is lowercase letters, digits, `.`, `_` and `-`, and starts with a letter or
  digit; any other id is refused.
- Two files claiming one id: the first in filename order wins, and the second
  is reported.
- A theme that is structurally sound but illegible (text too close to its
  background) is refused by the contrast gate before anything paints, and the
  app stays on the theme it was showing.

## Schema

```json
{
  "schemaVersion": 1,
  "id": "dracula",
  "label": "Dracula",
  "appearance": "dark",
  "description": "The classic dark theme, ported to Tori's roles",
  "license": "MIT",
  "contributor": { "name": "Zeno Rocha", "github": "zenorocha" },
  "colors": {
    "canvas": "#21222c",
    "card": "#282a36"
  }
}
```

- `schemaVersion` (required): this build supports `1`.
- `id` (required): unique, and the name of the file.
- `label` (required): shown in the theme picker.
- `appearance` (required): `"dark"` or `"light"`, which way native controls
  lean. It selects no colour.
- `colors` (required): every key in `PALETTE_KEYS` in `src/theme/schema.ts`,
  each a hex colour written `#rgb`, `#rrggbb` or `#rrggbbaa`. A missing key and
  an unknown key are both errors. The example above shows two of them.
- `description` (optional): one line for the theme's card.
- `license` (optional): the SPDX id of the licence this file is shared under.
  A port carries its upstream theme's licence.
- `contributor` (optional): who wrote this file, `name` and `github`, credited
  on its card.

Any other top-level key is an error, not a warning: a palette is the one pack
kind where a misspelt field can only mean a mistake.

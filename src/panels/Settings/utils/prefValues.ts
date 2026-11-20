// Here rather than in `commands.ts`, which may not import the store.
import { optionsOf } from "../../../utils/settingsCatalog";
import type { Promotion } from "../../../utils/topics";
import {
  editorDefaults,
  saveSettings,
  setEditorDefault,
  setSidebar,
  settings,
  type ActiveLineHighlight,
  type ChatDefaults,
  type DefaultSurface,
  type SpaceStrip,
  type Timestamps,
  type TranscriptDensity,
} from "../settingsStore";

type Pref = { get: () => string; set: (value: string) => void };

// Swallowed on failure, as `setEditorDefault` is: the panel shows what was saved.
const save = (write: Promise<void>) => void write.catch(() => {});
const chat = (patch: Partial<ChatDefaults>) =>
  save(saveSettings({ ...settings, chatDefaults: { ...settings.chatDefaults, ...patch } }));

const PREFS: Record<string, Pref> = {
  "topic-promotion": {
    get: () => settings.git.topicPromotion,
    set: (v) => save(saveSettings({ ...settings, git: { ...settings.git, topicPromotion: v as Promotion } })),
  },
  "space-strip": {
    get: () => settings.sidebar.spaceTiles,
    set: (v) => save(setSidebar({ spaceTiles: v as SpaceStrip })),
  },
  "active-line-highlight": {
    get: () => editorDefaults().activeLineHighlight,
    set: (v) => setEditorDefault("activeLineHighlight", v as ActiveLineHighlight),
  },
  "default-surface": {
    get: () => settings.chatDefaults.defaultSurface,
    set: (v) => chat({ defaultSurface: v as DefaultSurface }),
  },
  "transcript-density": {
    get: () => settings.chatDefaults.density,
    set: (v) => chat({ density: v as TranscriptDensity }),
  },
  timestamps: {
    get: () => settings.chatDefaults.timestamps,
    set: (v) => chat({ timestamps: v as Timestamps }),
  },
};

export const PREF_IDS = Object.keys(PREFS);

export function prefValue(id: string): string | undefined {
  return PREFS[id]?.get();
}

export function setPref(id: string, value: string) {
  if (optionsOf(id).some((o) => o.value === value)) PREFS[id]?.set(value);
}

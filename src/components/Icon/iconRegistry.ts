import {
  Rocket,
  Anchor,
  Atom,
  Award,
  Book,
  Bookmark,
  Box,
  Briefcase,
  Bug,
  Camera,
  Cloud,
  Code,
  Coffee,
  Compass,
  Cpu,
  Database,
  Feather,
  Flag,
  Flame,
  Folder,
  Gamepad2,
  Gem,
  Globe,
  Heart,
  House,
  Layers,
  Leaf,
  Lightbulb,
  Map as MapIcon,
  Moon,
  Music,
  Package,
  Palette,
  PenTool,
  Rss,
  Server,
  Star,
  Sun,
  Terminal,
  Zap,
} from "lucide-solid";
import type { LucideIcon } from "lucide-solid";

/** One picker entry: the stored key (Lucide PascalCase name) and its component. */
export interface SpaceIcon {
  /** The name stored in `sway.toml` and used by `resolveIcon`. */
  name: string;
  icon: LucideIcon;
}

// The fixed picker set: 40 statically imported icons, no barrel / lazy load /
// full search. The array order is the picker's display order; each `name` is the
// PascalCase key that round-trips picker → storage → tile with no conversion.
export const SPACE_ICONS: SpaceIcon[] = [
  { name: "Rocket", icon: Rocket },
  { name: "Anchor", icon: Anchor },
  { name: "Atom", icon: Atom },
  { name: "Award", icon: Award },
  { name: "Book", icon: Book },
  { name: "Bookmark", icon: Bookmark },
  { name: "Box", icon: Box },
  { name: "Briefcase", icon: Briefcase },
  { name: "Bug", icon: Bug },
  { name: "Camera", icon: Camera },
  { name: "Cloud", icon: Cloud },
  { name: "Code", icon: Code },
  { name: "Coffee", icon: Coffee },
  { name: "Compass", icon: Compass },
  { name: "Cpu", icon: Cpu },
  { name: "Database", icon: Database },
  { name: "Feather", icon: Feather },
  { name: "Flag", icon: Flag },
  { name: "Flame", icon: Flame },
  { name: "Folder", icon: Folder },
  { name: "Gamepad2", icon: Gamepad2 },
  { name: "Gem", icon: Gem },
  { name: "Globe", icon: Globe },
  { name: "Heart", icon: Heart },
  { name: "House", icon: House },
  { name: "Layers", icon: Layers },
  { name: "Leaf", icon: Leaf },
  { name: "Lightbulb", icon: Lightbulb },
  { name: "Map", icon: MapIcon },
  { name: "Moon", icon: Moon },
  { name: "Music", icon: Music },
  { name: "Package", icon: Package },
  { name: "Palette", icon: Palette },
  { name: "PenTool", icon: PenTool },
  { name: "Rss", icon: Rss },
  { name: "Server", icon: Server },
  { name: "Star", icon: Star },
  { name: "Sun", icon: Sun },
  { name: "Terminal", icon: Terminal },
  { name: "Zap", icon: Zap },
];

// Synchronous name → component lookup, built once from SPACE_ICONS.
const BY_NAME: Map<string, LucideIcon> = new Map(SPACE_ICONS.map((e) => [e.name, e.icon]));

/** Resolve a stored icon name to its Lucide component, or `undefined` when the
 *  key is unknown/blank so the caller can fall back to the space's letter. */
export function resolveIcon(name: string | undefined | null): LucideIcon | undefined {
  if (!name) return undefined;
  return BY_NAME.get(name);
}

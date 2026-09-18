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
  Binary,
  Blocks,
  Bot,
  Brain,
  Component,
  Container,
  GitBranch,
  GitFork,
  HardDrive,
  Keyboard,
  Laptop,
  Microchip,
  Network,
  Regex,
  Webhook,
  Workflow,
  Hammer,
  Wrench,
  Scissors,
  Ruler,
  Paperclip,
  Brush,
  Pencil,
  Magnet,
  FlaskConical,
  TestTube,
  Microscope,
  Telescope,
  Satellite,
  Orbit,
  Bird,
  Cat,
  Dog,
  Rabbit,
  Fish,
  Squirrel,
  Sprout,
  Trees,
  Mountain,
  Waves,
  Plane,
  Ship,
  Sailboat,
  Bike,
  Tent,
  Castle,
  Crown,
  Diamond,
  Key,
  Lock,
  Shield,
  Vault,
  Wallet,
  Coins,
  Pizza,
  Cake,
  Cookie,
  Apple,
  Wine,
  Film,
  Clapperboard,
  Headphones,
  Guitar,
  Joystick,
  Trophy,
  Medal,
  Target,
  Clock,
  Hourglass,
  Calendar,
  Infinity as InfinityIcon,
  Hexagon,
  Pyramid,
  Shapes,
  Ghost,
  Gift,
  PartyPopper,
  Sparkles,
  Eye,
  Glasses,
} from "lucide-solid";
import type { LucideIcon } from "lucide-solid";

/** One picker entry: the stored key (Lucide PascalCase name) and its component. */
export interface PickerIcon {
  /** The name stored in `tori.toml` and used by `resolveIcon`. */
  name: string;
  icon: LucideIcon;
}

// The fixed picker set: 120 statically imported icons, no barrel / lazy load, so
// the bundle carries exactly these and nothing else. The array order is the
// picker's display order (the original 40 first, then the themed additions);
// each `name` is the PascalCase key that round-trips picker → storage → tile
// with no conversion. One set serves both surfaces: a space tile and a project
// row store a name here and resolve it through the one map below.
export const PICKER_ICONS: PickerIcon[] = [
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
  // Code and infrastructure
  { name: "Binary", icon: Binary },
  { name: "Blocks", icon: Blocks },
  { name: "Bot", icon: Bot },
  { name: "Brain", icon: Brain },
  { name: "Component", icon: Component },
  { name: "Container", icon: Container },
  { name: "GitBranch", icon: GitBranch },
  { name: "GitFork", icon: GitFork },
  { name: "HardDrive", icon: HardDrive },
  { name: "Keyboard", icon: Keyboard },
  { name: "Laptop", icon: Laptop },
  { name: "Microchip", icon: Microchip },
  { name: "Network", icon: Network },
  { name: "Regex", icon: Regex },
  { name: "Webhook", icon: Webhook },
  { name: "Workflow", icon: Workflow },
  // Tools
  { name: "Hammer", icon: Hammer },
  { name: "Wrench", icon: Wrench },
  { name: "Scissors", icon: Scissors },
  { name: "Ruler", icon: Ruler },
  { name: "Paperclip", icon: Paperclip },
  { name: "Brush", icon: Brush },
  { name: "Pencil", icon: Pencil },
  { name: "Magnet", icon: Magnet },
  // Science
  { name: "FlaskConical", icon: FlaskConical },
  { name: "TestTube", icon: TestTube },
  { name: "Microscope", icon: Microscope },
  { name: "Telescope", icon: Telescope },
  { name: "Satellite", icon: Satellite },
  { name: "Orbit", icon: Orbit },
  // Nature and animals
  { name: "Bird", icon: Bird },
  { name: "Cat", icon: Cat },
  { name: "Dog", icon: Dog },
  { name: "Rabbit", icon: Rabbit },
  { name: "Fish", icon: Fish },
  { name: "Squirrel", icon: Squirrel },
  { name: "Sprout", icon: Sprout },
  { name: "Trees", icon: Trees },
  { name: "Mountain", icon: Mountain },
  { name: "Waves", icon: Waves },
  // Travel and places
  { name: "Plane", icon: Plane },
  { name: "Ship", icon: Ship },
  { name: "Sailboat", icon: Sailboat },
  { name: "Bike", icon: Bike },
  { name: "Tent", icon: Tent },
  { name: "Castle", icon: Castle },
  // Valuables
  { name: "Crown", icon: Crown },
  { name: "Diamond", icon: Diamond },
  { name: "Key", icon: Key },
  { name: "Lock", icon: Lock },
  { name: "Shield", icon: Shield },
  { name: "Vault", icon: Vault },
  { name: "Wallet", icon: Wallet },
  { name: "Coins", icon: Coins },
  // Food and drink
  { name: "Pizza", icon: Pizza },
  { name: "Cake", icon: Cake },
  { name: "Cookie", icon: Cookie },
  { name: "Apple", icon: Apple },
  { name: "Wine", icon: Wine },
  // Media and play
  { name: "Film", icon: Film },
  { name: "Clapperboard", icon: Clapperboard },
  { name: "Headphones", icon: Headphones },
  { name: "Guitar", icon: Guitar },
  { name: "Joystick", icon: Joystick },
  { name: "Trophy", icon: Trophy },
  { name: "Medal", icon: Medal },
  { name: "Target", icon: Target },
  // Time and shapes
  { name: "Clock", icon: Clock },
  { name: "Hourglass", icon: Hourglass },
  { name: "Calendar", icon: Calendar },
  { name: "Infinity", icon: InfinityIcon },
  { name: "Hexagon", icon: Hexagon },
  { name: "Pyramid", icon: Pyramid },
  { name: "Shapes", icon: Shapes },
  // Expressive
  { name: "Ghost", icon: Ghost },
  { name: "Gift", icon: Gift },
  { name: "PartyPopper", icon: PartyPopper },
  { name: "Sparkles", icon: Sparkles },
  { name: "Eye", icon: Eye },
  { name: "Glasses", icon: Glasses },
];

// Synchronous name → component lookup, built once from PICKER_ICONS.
const BY_NAME: Map<string, LucideIcon> = new Map(PICKER_ICONS.map((e) => [e.name, e.icon]));

/** Resolve a stored icon name to its Lucide component, or `undefined` when the
 *  key is unknown/blank so the caller can fall back to the space's letter. */
export function resolveIcon(name: string | undefined | null): LucideIcon | undefined {
  if (!name) return undefined;
  return BY_NAME.get(name);
}

// Strip everything but letters and digits so a typed query matches a PascalCase
// key however it is spaced: "git branch", "GitBranch" and "gitbranch" all hit
// `GitBranch`. Without this, search would miss every compound name in the set.
function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The picker set filtered by a free-text query (substring, case- and
 *  separator-insensitive). A blank query returns the whole set in its
 *  declaration order, which is the picker's default view. */
export function searchIcons(query: string): PickerIcon[] {
  const q = squash(query);
  if (!q) return PICKER_ICONS;
  return PICKER_ICONS.filter((e) => squash(e.name).includes(q));
}

/** How many icons a picker rests on.
 *
 *  All of them at once is a wall you scroll past rather than a set you read,
 *  and in a dialog whose real question is a name or an image it is the tallest
 *  thing on screen. A short shelf says what an icon here looks like; the field
 *  above it is how you reach a particular one, which is the only way anyone
 *  finds one in a set this size anyway. */
export const SHELF = 24;

/** `size` icons drawn from the set without repeats.
 *
 *  Draw it once for the life of a picker and hold it: per keystroke, or per
 *  render, would reshuffle the shelf under the pointer on its way to a tile. */
export function drawShelf(size: number = SHELF): PickerIcon[] {
  const pool = [...PICKER_ICONS];
  const out: PickerIcon[] = [];
  while (out.length < size && pool.length) {
    out.push(...pool.splice(Math.floor(Math.random() * pool.length), 1));
  }
  return out;
}

/** `shelf` with `chosen` forced into it, which is what a picker shows at rest.
 *
 *  A stored icon, or one a reroll landed on, is anywhere in the set, and a
 *  picker showing nothing selected reads as having lost the choice rather than
 *  as not showing it. The forced entry takes the front and the shelf keeps its
 *  length, so the block below the field never changes height. */
export function restingShelf(shelf: PickerIcon[], chosen: string | null): PickerIcon[] {
  if (!chosen || shelf.some((e) => e.name === chosen)) return shelf;
  const entry = PICKER_ICONS.find((e) => e.name === chosen);
  return entry ? [entry, ...shelf.slice(0, shelf.length - 1)] : shelf;
}

/** The glyph a project gets when nobody chose one and no favicon was found: a
 *  stable pick from the set, hashed on `seed` (the project's absolute path). It
 *  reads as an arbitrary icon, but it is the *same* arbitrary icon on every
 *  render and every run - a genuinely random pick would reshuffle the whole
 *  sidebar each time the tree re-rendered. */
export function fallbackIcon(seed: string): LucideIcon {
  // FNV-1a over the seed's UTF-16 units; `>>> 0` keeps every step unsigned.
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return PICKER_ICONS[h % PICKER_ICONS.length].icon;
}

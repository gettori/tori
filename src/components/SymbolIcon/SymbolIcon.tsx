import {
  Ban,
  Binary,
  Blocks,
  Box,
  Boxes,
  Braces,
  Brackets,
  CaseSensitive,
  CircleDot,
  Diamond,
  FileCode,
  Hash,
  Key,
  List,
  Package,
  Parentheses,
  SquareFunction,
  ToggleLeft,
  Type,
  Variable,
  Zap,
  type LucideIcon,
} from "lucide-solid";
import Icon from "../Icon/Icon";
import { symbolKindName } from "../../utils/symbols";

// LSP `SymbolKind` to a glyph. Shared because both surfaces that list symbols
// want the same one: a method has to look like a method in the outline and in
// the palette, or the two read as different kinds of thing.
const KIND_ICONS: Record<number, LucideIcon> = {
  1: FileCode, // File
  2: Package, // Module
  3: Boxes, // Namespace
  4: Package, // Package
  5: Box, // Class
  6: SquareFunction, // Method
  7: Diamond, // Property
  8: Diamond, // Field
  9: SquareFunction, // Constructor
  10: List, // Enum
  11: Blocks, // Interface
  12: SquareFunction, // Function
  13: Variable, // Variable
  14: Binary, // Constant
  15: CaseSensitive, // String
  16: Hash, // Number
  17: ToggleLeft, // Boolean
  18: Brackets, // Array
  19: Braces, // Object
  20: Key, // Key
  21: Ban, // Null
  22: CircleDot, // EnumMember
  23: Box, // Struct
  24: Zap, // Event
  25: Parentheses, // Operator
  26: Type, // TypeParameter
};

/** The glyph for an LSP symbol kind. A kind this client has never heard of
 *  still gets one: the symbol is real, and a blank column beside it would read
 *  as a rendering bug rather than as an unfamiliar kind. */
export default function SymbolIcon(props: { kind: number; class?: string }) {
  return (
    <Icon
      icon={KIND_ICONS[props.kind] ?? CircleDot}
      class={props.class}
      aria-label={symbolKindName(props.kind)}
    />
  );
}

import { splitProps, type Component, type JSX } from "solid-js";
import styles from "./agentMarks.module.css";

/**
 * Every agent logo Tori has, in one place.
 *
 * The marks are keyed by an adapter's `icon` field (`src-tauri/packs/agents/*.toml`),
 * not by its id, so a user's own `claude-yolo` adapter can wear the Claude mark
 * by naming it rather than by being called Claude. An adapter that names no
 * icon, or names one this build has never heard of, gets nothing back from
 * `agentMark` and the call site falls back to its own default - a monogram
 * letter on the settings cards, the generic brain in `ProviderIcon`.
 *
 * **Only marks we actually have.** An agent with no logo here keeps the
 * fallback rather than borrowing a neighbour's: a mark is a claim about who is
 * running the turn, and a wrong one is worse than a generic one. That rule
 * predates this file - it is why `ProviderIcon` shipped with one mark - and is
 * why an empty slot stays empty rather than holding an approximation.
 *
 * Path data is pasted in as the 24x24 single-path `d`, monochrome, tinting from
 * `currentColor`. Simple Icons (CC0 1.0) is the source for all but one; Codex
 * has no entry there and comes from lobe-icons (MIT) instead, noted on the
 * constant. Inlined rather than depending on either package: the marks change
 * about as often as the companies rebrand, and a dependency would pull a few
 * hundred icons to ship a dozen.
 *
 * **From the upstream set, never from another app.** The obvious shortcut is to
 * lift all of these from a competitor that already has them; the reason not to
 * is that the nearest one is AGPL-3.0 while Tori is Apache-2.0, so
 * copying its components would be a licence conflict rather than a saved
 * afternoon. Its own LICENSE points at the way round: third-party components
 * keep their original licence, so the answer is to go to that original.
 */

export type MarkProps = JSX.SvgSVGAttributes<SVGSVGElement> & {
  size?: number | string;
  /** Taken and dropped: `Icon` passes one to every glyph, and a filled mark
   *  that let it through would inherit a stroke it does not draw with. */
  strokeWidth?: number | string;
  /** Breathe, for a turn that is still running. See `.thinking`. */
  animated?: boolean;
};

/** Wraps a brand path as something `<Icon>` can render. `Icon` renders through
 *  `Dynamic` with `size`, `strokeWidth` and `class`, and a *filled* mark has to
 *  take `size` as its box and drop the stroke width rather than inherit it.
 *
 *  `viewBox` exists because **not every source normalizes its artwork the same
 *  way**. Simple Icons ships each mark inked to the full 24x24; a logo lifted
 *  from a plated icon set is drawn inset inside that box, and rendering it at
 *  the same `size` puts it on screen visibly smaller than its neighbours.
 *  Cropping to the ink is what makes one `size` mean one size. */
export function brandMark(path: string, viewBox = "0 0 24 24"): Component<MarkProps> {
  return (props) => {
    const [local, rest] = splitProps(props, ["size", "strokeWidth", "animated", "class"]);
    return (
      <svg
        viewBox={viewBox}
        width={local.size ?? 16}
        height={local.size ?? 16}
        fill="currentColor"
        aria-hidden="true"
        classList={{ [styles.thinking]: !!local.animated, [local.class ?? ""]: !!local.class }}
        {...rest}
      >
        <path d={path} />
      </svg>
    );
  };
}

/** Anthropic's Claude mark, as Simple Icons publishes it (24x24, one filled
 *  path). It tints from `currentColor` like every other icon here instead of
 *  carrying the brand orange into a muted row. */
const CLAUDE =
  "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z";

/** OpenCode's mark (Simple Icons slug `opencode`), which really is two
 *  rectangles - a filled square with a smaller one knocked out of it. */
const OPENCODE = "M22 24H2V0h20zM17 4.8H7v14.4h10z";

/** The marks the other bundled adapters name, same source, same terms. */
const COPILOT =
  "M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z";

const PI = "M0 0v24h6v-6h6v-6H6V6h6v6h6V0Zm18 12v12h6V12Z";

/** OpenAI's Codex mark. **The one path here that is not Simple Icons'**: it has
 *  no entry there, so this comes from lobe-icons (MIT) instead.
 *
 *  Monochromed on the way in, like the rest. The source draws three things - a
 *  white rounded plate, this shape over it, and a purple-to-blue gradient
 *  filling it - and only the shape survives: a mark that carried its own
 *  background would sit as a white tile in a muted row, and one that carried its
 *  own gradient would ignore the theme every other glyph obeys. The two inner
 *  cuts are holes in this path, so they show whatever is behind the glyph rather
 *  than needing the plate. */
const CODEX =
  "M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z";

/** Every mark this build has, keyed by the name an adapter's `icon` field
 *  declares (which for every bundled adapter is also its id). An entry left as
 *  an empty string resolves to no mark, which is the same answer as an unknown
 *  key and lands the call site on its fallback.
 *
 *  A note for whoever adds the next one: match on the *brand*, never the name.
 *  Simple Icons publishes slugs like `amp`, `x` and `square` that a name-based
 *  sweep would happily pair with agents of the same name, and all three are a
 *  different company (Google's Accelerated Mobile Pages, the social network,
 *  Block's payments brand). A confident wrong logo is the one outcome this
 *  file exists to avoid. */
const PATHS: Record<string, string> = {
  claude: CLAUDE,
  codex: CODEX,
  copilot: COPILOT,
  opencode: OPENCODE,
  pi: PI,
};

/** Marks whose artwork does not ink the full 24x24, with the box that crops to
 *  what it does ink. Measured, not eyeballed: every Simple Icons path above
 *  spans the full 24 in its longest axis, and Codex's spans 18, inset by
 *  exactly 3 a side because the source drew it on a rounded plate. Without this
 *  it renders at three quarters the size of every mark beside it. */
const VIEW_BOXES: Record<string, string> = {
  codex: "3 3 18 18",
};

const MARKS: Record<string, Component<MarkProps>> = Object.fromEntries(
  Object.entries(PATHS)
    .filter(([, d]) => d !== "")
    .map(([name, d]) => [name, brandMark(d, VIEW_BOXES[name])]),
);

/** Resolve a mark name (an adapter's `icon`, or its id for callers that have
 *  nothing better) to its logo, or `undefined` when this build has none for
 *  it, so the caller can fall back to something that claims nothing. */
export function agentMark(name: string | null | undefined): Component<MarkProps> | undefined {
  if (!name) return undefined;
  return MARKS[name];
}

/** Which keys resolve today. Exported for the test that pins this against the
 *  bundled adapters, so a renamed `icon` field is caught here rather than by a
 *  glyph quietly going missing. */
export function knownMarks(): string[] {
  return Object.keys(MARKS);
}

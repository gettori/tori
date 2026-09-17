/** What a hand-rolled modal's Tab wrap stops on. Excludes disabled controls,
 *  which a browser skips too, and anything parked at `tabindex="-1"`.
 *
 *  Shared by the surfaces that trap focus themselves rather than through
 *  `Dialog`, so their tests assert against the trap's own list rather than a
 *  hand-copied one. */
export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

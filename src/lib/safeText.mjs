/**
 * Text that reaches a terminal verbatim.
 *
 * Two shipped surfaces need the same guarantee and must not each grow their own
 * copy: the update plan renders Kit-authored manifest prose, and `routing status`
 * renders diagnostics that can carry an external error message. Either would
 * repaint the terminal if a control sequence rode through, so both strip C0/C1
 * control characters here.
 *
 * This module is a leaf on purpose: it imports nothing, so an installed consumer
 * receives it whole without dragging the installer-side update machinery along.
 */

/**
 * Validate that a value is a string and strip C0/C1 control characters plus
 * redundant whitespace from it. Returns null for a non-string or an input that
 * sanitizes to nothing, so a caller can distinguish "absent" from "empty".
 */
export function sanitizeReadinessText(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || null;
}

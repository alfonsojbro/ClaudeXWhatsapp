/**
 * Every interpolated value goes through here.
 *
 * A local copy of `apps/console-ui/src/render/escape.ts`, because `@cxw/console` has zero
 * dependencies and the UI package is not one of them. Same escape set, same rule: a render
 * function that writes a string into the document without it is a bug. The strings on this
 * page include a phone number someone typed, a routine filename someone chose, and a git
 * remote someone pasted — all of them untrusted.
 */

const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes for text nodes and for double-quoted attribute values alike. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ENTITIES[character] ?? character);
}

/**
 * An attribute value, quotes included. Separate from `escapeHtml` only so a call site reads
 * as "this is an attribute" — the escape set already covers both positions.
 */
export function attr(value: unknown): string {
  return `"${escapeHtml(value)}"`;
}

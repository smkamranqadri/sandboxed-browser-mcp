import { ToolError } from "./errors.js";

/**
 * Refs: `e<n>` or `f<n>e<n>` (the f-part says which document), as the view writes them in brackets. They are the
 * browser's own element references (Playwright's aria refs): a ref stays the same while its element is on the page and
 * keeps its role and name, and one from a document that is gone names a frame that no longer exists.
 */

export const REF = /^(?:f\d+)?e\d+$/;

/** The ref as given, without brackets, spaces or a `ref=` before it; a ToolError when it is not shaped like a ref. */
export function checkRef(raw: string): string {
  let ref = raw.trim();
  if (ref.startsWith("[") && ref.endsWith("]")) ref = ref.slice(1, -1).trim();
  if (ref.startsWith("ref=")) ref = ref.slice("ref=".length);
  if (REF.test(ref)) return ref;
  throw new ToolError(`"${raw}" cannot be used as a ref: refs are short codes such as e12 or f2e7, copied from the brackets that end a line of browser_snapshot or browser_find.`);
}

/** The one answer for a ref that points at nothing now. */
export const gone = (ref: string): ToolError =>
  new ToolError(`${ref} points at nothing on the page now: its element was removed or replaced, the page changed, or it never existed. Get a fresh ref from browser_snapshot or browser_find.`);

/** Whether a browser error says the ref points nowhere (a frame of a document that is gone). */
export const refGoneError = (e: unknown): boolean => /Invalid frame in aria-ref selector|Frame was detached|frame got detached/i.test(String(e));

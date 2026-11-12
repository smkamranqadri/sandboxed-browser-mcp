import { ToolError } from "./errors.js";

/**
 * Refs: `e<n>` or `f<n>e<n>` (the f-part says which document), as the view writes them in brackets. They are the
 * browser's own element references (Playwright's aria refs): a ref stays the same while its element is on the page and
 * keeps its role and name, and one from a document that is gone names a frame that no longer exists.
 */

export const REF = /^(?:f\d+)?e\d+$/;

/** Which profile a call is for, and whether refs carry a profile tag (when the client has several profiles). */
export interface RefScope {
  profile: string;
  tagged: boolean;
}

const BAD_REF = (raw: string): ToolError =>
  new ToolError(`"${raw}" cannot be used as a ref: refs are short codes such as e12 or f2e7, copied from the brackets that end a line of browser_snapshot or browser_find.`);

/**
 * The ref as given, without brackets, spaces or a `ref=` before it; a ToolError when it is not shaped like a ref.
 * Refs belong to one page of one profile's browser. When the client has several profiles, the refs of every profile but
 * `default` are shown with a tag (`e12@work`), and a call accepts only the ref of its own profile.
 */
export function checkRef(raw: string, scope?: RefScope): string {
  let ref = raw.trim();
  if (ref.startsWith("[") && ref.endsWith("]")) ref = ref.slice(1, -1).trim();
  if (ref.startsWith("ref=")) ref = ref.slice("ref=".length);
  const at = ref.indexOf("@");
  const tag = at < 0 ? undefined : ref.slice(at + 1);
  const bare = at < 0 ? ref : ref.slice(0, at);
  if (!REF.test(bare)) throw BAD_REF(raw);
  const wanted = scope && scope.tagged && scope.profile !== "default" ? scope.profile : undefined;
  if (tag === undefined && wanted === undefined) return bare;
  if (tag !== undefined && scope && tag === scope.profile) return bare;
  if (tag !== undefined) {
    throw new ToolError(`${bare}@${tag} is a ref of ${tag === "default" ? "the default profile" : `profile ${tag}`}, and this call is for ${scope ? `profile ${scope.profile}` : "no other profile"}: a ref works only in the profile it came from. Get a ref from this profile's own browser_snapshot or browser_find.`);
  }
  throw new ToolError(`${bare} has no profile tag, so it is a ref of the default profile, and this call is for profile ${wanted}: a ref works only in the profile it came from. Refs of profile ${wanted} end in @${wanted} (${bare}@${wanted}); get one from this profile's own browser_snapshot or browser_find.`);
}

/** Writes the tag after every ref in brackets of an answer (`[e12]` to `[e12@work]`), for a profile whose refs carry one. */
export const tagRefs = (text: string, profile: string): string => text.replace(/\[((?:f\d+)?e\d+)\]/g, `[$1@${profile}]`);

/** The one answer for a ref that points at nothing now. */
export const gone = (ref: string): ToolError =>
  new ToolError(`${ref} points at nothing on the page now: its element was removed or replaced, the page changed, or it never existed. Get a fresh ref from browser_snapshot or browser_find.`);

/** Whether a browser error says the ref points nowhere (a frame of a document that is gone). */
export const refGoneError = (e: unknown): boolean => /Invalid frame in aria-ref selector|Frame was detached|frame got detached/i.test(String(e));

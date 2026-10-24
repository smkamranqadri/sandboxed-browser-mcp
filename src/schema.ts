/**
 * The tools' argument schemas: small JSON schemas (string, number, boolean, enum; a required list) that the server
 * checks itself (validate.ts) and lists to clients. Names, types, defaults and required lists are a public interface.
 */

type Field = { type: "string" | "number" | "boolean"; description: string; enum?: string[]; default?: unknown };

export type Schema = {
  type: "object";
  properties: Record<string, Field>;
  required?: string[];
  additionalProperties: false;
};

/** A schema of `fields`; the names after them are the required ones. */
function params(fields: Record<string, Field>, ...required: string[]): Schema {
  const schema: Schema = { type: "object", properties: fields, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}

/** A ref argument, for `purpose`. */
function refField(purpose: string): Field {
  return { type: "string", description: `Ref of ${purpose} (e12, f2e7 …), as browser_snapshot or browser_find showed it.` };
}

export const SCHEMAS = {
  browser_navigate: params({ url: { type: "string", description: "Where to go: a complete URL including its scheme, e.g. https://…" } }, "url"),
  browser_back: params({}),
  browser_snapshot: params({
    mode: {
      type: "string",
      enum: ["a11y", "index"],
      default: "a11y",
      description: '"a11y" (default) shows the page as it reads; "index" lists only the controls, one per line.',
    },
  }),
  browser_click: params(
    {
      ref: refField("the element to click"),
      double: { type: "boolean", default: false, description: "true for a double-click." },
    },
    "ref",
  ),
  browser_type: params(
    {
      ref: refField("the field to type into"),
      text: { type: "string", description: "What the field should contain afterwards (its old text is replaced)." },
      submit: { type: "boolean", default: false, description: "true to press Enter once the text is in." },
    },
    "ref",
    "text",
  ),
  browser_select: params(
    {
      ref: refField("the dropdown"),
      option: { type: "string", description: "The option to pick, by the text it shows." },
    },
    "ref",
    "option",
  ),
  browser_key: params({ key: { type: "string", description: "One key or a +-joined combination, e.g. Enter, Escape, PageDown, ctrl+a, cmd+shift+t." } }, "key"),
  browser_scroll: params({
    direction: { type: "string", enum: ["down", "up"], default: "down", description: "down (default) or up." },
    screens: { type: "number", default: 1, description: "Distance in screens, from 0.25 to 10 (default 1)." },
    ref: refField("an element to scroll to, in place of a distance"),
  }),
  browser_find: params({ query: { type: "string", description: "The words to look for; an element matches when its name or text has all of them (any case)." } }, "query"),
  browser_get_text: params(
    {
      ref: refField("the element to read"),
      offset: { type: "number", default: 0, description: "Character to start at; the previous answer's footer gives the next one." },
      max_chars: { type: "number", default: 2000, description: "Most characters to return in this part." },
    },
    "ref",
  ),
  browser_screenshot: params({ ref: refField("one element to picture; leave it out for the whole viewport") }),
} satisfies Record<string, Schema>;

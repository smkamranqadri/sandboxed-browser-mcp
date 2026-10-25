/**
 * Checks tool arguments against the small JSON schemas of schema.ts (string, number, boolean, enum, a non-empty array
 * of strings; required list), before a tool runs: an MCP client may send anything. Returns an error message, or null.
 */
export function validateArgs(schema: Record<string, unknown>, args: unknown): string | null {
  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) return "Arguments must be an object.";
  const given = (args ?? {}) as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, { type?: string; enum?: unknown[]; minItems?: number }>;
  const required = (schema.required ?? []) as string[];
  for (const name of required) {
    if (given[name] === undefined || given[name] === null) return `Missing argument "${name}".`;
  }
  for (const [name, value] of Object.entries(given)) {
    if (value === undefined || value === null) continue;
    const spec = properties[name];
    if (!spec) return `Unknown argument "${name}".`;
    if (spec.type === "array") {
      if (!Array.isArray(value)) return `Argument "${name}" must be an array of strings.`;
      if (value.length < (spec.minItems ?? 0)) return `Argument "${name}" must have at least ${spec.minItems} item${spec.minItems === 1 ? "" : "s"}.`;
      const at = value.findIndex((v) => typeof v !== "string");
      if (at >= 0) return `Argument "${name}[${at}]" must be a string.`;
      continue;
    }
    if (spec.type === "number" ? typeof value !== "number" || !Number.isFinite(value) : spec.type && typeof value !== spec.type) {
      return `Argument "${name}" must be a ${spec.type}.`;
    }
    if (spec.enum && !spec.enum.includes(value)) return `Argument "${name}" must be one of: ${spec.enum.join(", ")}.`;
  }
  return null;
}

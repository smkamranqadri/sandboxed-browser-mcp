/**
 * Checks tool arguments against the small JSON schemas of schema.ts (string, number, boolean, enum; required list),
 * before a tool runs: an MCP client may send anything. Returns an error message, or null.
 */
export function validateArgs(schema: Record<string, unknown>, args: unknown): string | null {
  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) return "Arguments must be an object.";
  const given = (args ?? {}) as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, { type?: string; enum?: unknown[] }>;
  const required = (schema.required ?? []) as string[];
  for (const name of required) {
    if (given[name] === undefined || given[name] === null) return `Missing argument "${name}".`;
  }
  for (const [name, value] of Object.entries(given)) {
    if (value === undefined || value === null) continue;
    const spec = properties[name];
    if (!spec) return `Unknown argument "${name}".`;
    if (spec.type === "number" ? typeof value !== "number" || !Number.isFinite(value) : spec.type && typeof value !== spec.type) {
      return `Argument "${name}" must be a ${spec.type}.`;
    }
    if (spec.enum && !spec.enum.includes(value)) return `Argument "${name}" must be one of: ${spec.enum.join(", ")}.`;
  }
  return null;
}

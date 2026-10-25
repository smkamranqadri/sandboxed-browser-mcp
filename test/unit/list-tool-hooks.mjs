/**
 * Module hooks for server.test.mjs: the built server (dist/server.js) gets list-tool.mjs in place of its tools.js, so
 * that the real MCP request handler serves one extra tool taking an array argument. Everything else loads as built.
 */
export async function resolve(specifier, context, next) {
  if (specifier === "./tools.js" && context.parentURL?.endsWith("/dist/server.js")) {
    return { url: new URL("./list-tool.mjs", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}

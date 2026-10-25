import { browserTools as builtTools } from "../../dist/tools.js";

/**
 * The built tools.js with one test tool after the eleven: test_list takes a ref and a non-empty array of strings, and
 * answers with the arguments it was given. No real tool takes an array yet; this shows one through the server.
 */
export * from "../../dist/tools.js";

export function browserTools(sessionId) {
  return [
    ...builtTools(sessionId),
    {
      name: "test_list",
      label: "List",
      description: "Answers with its arguments, as the server passed them on.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "A ref." },
          files: { type: "array", items: { type: "string" }, minItems: 1, description: "Paths." },
        },
        required: ["ref", "files"],
        additionalProperties: false,
      },
      execute: async (_callId, args) => ({ content: [{ type: "text", text: JSON.stringify(args) }] }),
    },
  ];
}

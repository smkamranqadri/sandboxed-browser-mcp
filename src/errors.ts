/**
 * An answer of the server's own words (a refusal, a short reason), given to the model as it is, not wrapped as page
 * content. Its name stays "Error", so it prints as any error does.
 */
export class ToolError extends Error {}

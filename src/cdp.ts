/** The browser's debugging endpoint: BROWSER_CDP_URL, or the compose file's published port on this machine. */
export const cdpUrl = (): string => (process.env.BROWSER_CDP_URL || "http://127.0.0.1:9322").replace(/\/+$/, "");

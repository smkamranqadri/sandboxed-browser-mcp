import { chromium, type Browser } from "playwright-core";
import { ToolError } from "./errors.js";

/**
 * The Playwright connection to one browser (one profile's), over CDP. It is opened on
 * first use, opened again on the next use after the browser or the relay dropped it, and only one opening is ever under
 * way at a time.
 */
export class BrowserLink {
  private open: Browser | undefined;
  private opening: Promise<Browser> | undefined;

  /** `cdp` gives the browser's debugging address; `profile` is named in a failure, when it is not the default one. */
  constructor(
    private readonly cdp: () => string,
    private readonly profile = "default",
  ) {}

  /** The connected browser. */
  get(): Promise<Browser> {
    if (this.open?.isConnected()) return Promise.resolve(this.open);
    this.opening ??= this.connect().finally(() => (this.opening = undefined));
    return this.opening;
  }

  /** Whether `browser` is the connection in use now (a tab of an older one is picked again). */
  holds(browser: Browser | undefined): boolean {
    return !!browser && browser === this.open;
  }

  private async connect(): Promise<Browser> {
    let browser: Browser;
    try {
      browser = await chromium.connectOverCDP(this.cdp(), { timeout: 15_000 });
    } catch (e) {
      const why = String(e instanceof Error ? e.message : e)
        .replace(/\x1b\[[0-9;]*m/g, "")
        .split("\n")[0]
        .replace(/^[\w.]+: /, "")
        .slice(0, 200);
      const named = this.profile === "default" ? "" : ` of profile ${this.profile}`;
      throw new ToolError(`Could not connect to the browser${named} at ${this.cdp()} (${why}). Is the browser stack running? (docker compose -f docker/compose.yaml up -d; BROWSER_CDP_URL says where it is.)`);
    }
    browser.on("disconnected", () => {
      if (this.open === browser) this.open = undefined;
    });
    this.open = browser;
    return browser;
  }

  /** Lets the browser go: the connection closes, the browser and its tabs stay. */
  async release(): Promise<void> {
    const browser = this.open;
    this.open = undefined;
    if (browser) await browser.close().catch(() => {});
  }
}

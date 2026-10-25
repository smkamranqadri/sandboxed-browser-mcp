import type { FileChooser, Page } from "playwright-core";
import { link } from "./connection.js";
import { ToolError } from "./errors.js";

/**
 * File choosers caught during one action of the agent's, on the followed page only: armed just before the one click,
 * released on every way out of the call, and at once when the call is given up. While armed, a chooser the page opens is intercepted (no native dialog opens
 * on the container's desktop) and handed to the call; once released, choosers open the native dialog again.
 *
 * Playwright switches interception (CDP Page.setInterceptFileChooserDialog, on the page and each of its frame sessions)
 * as the first "filechooser" listener is added and the last removed, without waiting for the browser to confirm it. So
 * the capture asks the page's channel itself and waits for the answer, which Playwright gives only once every frame
 * session has confirmed: interception on before the listener is added, off before it is removed. Until a release is
 * confirmed, nothing may assume interception is off: `settledChoosers()` waits for it, and runCall (tools.ts) awaits
 * that before the next call starts, so a call given up at its time limit holds back the next one until its capture is
 * really gone. A browser that does not confirm in time has its connection dropped instead, which ends this client's
 * interception with it, so nothing waits on it forever.
 */

/** How long a release waits for the browser to confirm, and then for the connection to close (tests shorten it). */
export const RELEASE_LIMIT = { ms: 10_000 };

/** Whether `work` ended within `ms`; it is not waited for after that. */
async function within(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  try {
    return await Promise.race([work.then(() => true, () => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Releases started or still to come whose confirmation has not arrived. */
const unsettled = new Set<Promise<void>>();

/** Once every capture armed so far is released and the browser has confirmed interception is off. */
export async function settledChoosers(): Promise<void> {
  while (unsettled.size) await Promise.all(unsettled);
}

type Subscriptions = { _channel: { updateSubscription(params: { event: "fileChooser"; enabled: boolean }): Promise<void> } };

/** Interception on the page and its frames switched, resolved once the browser has confirmed it. */
const intercept = (page: Page, enabled: boolean): Promise<void> =>
  (page as unknown as Subscriptions)._channel.updateSubscription({ event: "fileChooser", enabled });

export class ChooserCapture {
  /** The choosers caught so far, in order. */
  readonly caught: FileChooser[] = [];
  private wake: (() => void) | undefined;
  private readonly listener = (chooser: FileChooser) => {
    this.caught.push(chooser);
    this.wake?.();
  };
  private released: Promise<void> | undefined;
  private settle!: () => void;
  private readonly settled = new Promise<void>((resolve) => (this.settle = resolve));

  private constructor(private readonly page: Page) {
    unsettled.add(this.settled);
    void this.settled.then(() => unsettled.delete(this.settled));
  }

  /** A capture on `page`, armed: interception confirmed on, then the listener added. */
  static async arm(page: Page): Promise<ChooserCapture> {
    const capture = new ChooserCapture(page);
    try {
      const on = intercept(page, true);
      if (!(await within(on, RELEASE_LIMIT.ms))) throw new ToolError("The browser did not answer in time, so nothing was clicked. Try again, or tell the user.");
      await on;
    } catch (e) {
      await capture.release();
      throw e;
    }
    page.on("filechooser", capture.listener);
    return capture;
  }

  /** The first chooser caught, waiting until `ms` from now for one; null when none came in time. */
  async first(ms: number): Promise<FileChooser | null> {
    if (!this.caught.length && !this.released && ms > 0) {
      let timer: NodeJS.Timeout | undefined;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        timer = setTimeout(resolve, ms);
      });
      clearTimeout(timer);
      this.wake = undefined;
    }
    return this.caught[0] ?? null;
  }

  /**
   * Interception off on the page and its frames, confirmed, and only then the listener removed (removing it first would
   * have Playwright switch interception off unawaited, and this call's own switch would then find nothing to wait for).
   * The same promise for every caller; it does not reject: a page that closed has no interception left, and a browser
   * that does not answer in time loses this connection, and the interception with it.
   */
  release(): Promise<void> {
    this.released ??= (async () => {
      this.wake?.();
      let switched: Promise<void>;
      try {
        switched = intercept(this.page, false);
      } catch (e) {
        switched = Promise.reject(e);
      }
      if (!(await within(switched, RELEASE_LIMIT.ms))) await within(link.release(), RELEASE_LIMIT.ms);
      try {
        this.page.off("filechooser", this.listener);
      } catch {
        /* as above */
      }
      // Settled whatever happened above: a barrier that never settles would hold back every call after it.
      this.settle();
    })();
    return this.released;
  }
}

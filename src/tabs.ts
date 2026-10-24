import type { CDPSession, Page } from "playwright-core";

/**
 * What the tools keep about the browser's tabs beyond Playwright's view of them: each tab's own CDP session (for its
 * target id, its history, and the cursor), which tabs are known to be gone, and which tab was opened last.
 */

export type Channel = { session: CDPSession; targetId: string };

const channels = new WeakMap<Page, Promise<Channel>>();

/** The tab's CDP session and target id (the guard names its refusals by target id), set up once per tab. */
export function channel(page: Page): Promise<Channel> {
  const known = channels.get(page);
  if (known) return known;
  const made = (async (): Promise<Channel> => {
    const session = await page.context().newCDPSession(page);
    const info = (await session.send("Target.getTargetInfo")) as { targetInfo: { targetId: string } };
    return { session, targetId: info.targetInfo.targetId };
  })();
  channels.set(page, made);
  made.catch(() => channels.delete(page));
  return made;
}

/** Tabs found closed before Playwright reported it; never chosen again. */
export const closed = new WeakSet<Page>();

/**
 * Whether the tab still exists, by asking the browser (not the page, which may be stuck) over the tab's session. A tab
 * with no session yet is taken to exist: the call that uses it will find out.
 */
export async function exists(page: Page): Promise<boolean> {
  const known = channels.get(page);
  if (!known) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("no answer from the browser")), 3000)));
  try {
    await Promise.race([known.then((c) => c.session.send("Target.getTargetInfo")), timeout]);
    return true;
  } catch {
    channels.delete(page);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The tab opened last among `pages`. The browser lists tabs in other orders (by attachment, or by recent use), but the
 * ids of history entries only grow, so the tab whose first entry has the highest id was opened last.
 */
export async function lastOpened(pages: Page[]): Promise<Page | undefined> {
  if (pages.length < 2) return pages[0];
  const firstEntry = async (page: Page): Promise<number> => {
    try {
      const { session } = await channel(page);
      const history = (await session.send("Page.getNavigationHistory")) as { entries?: Array<{ id: number }> };
      return history.entries?.[0]?.id ?? -1;
    } catch {
      closed.add(page);
      return Number.NEGATIVE_INFINITY;
    }
  };
  const ids = await Promise.all(pages.map(firstEntry));
  const top = Math.max(...ids);
  if (top === Number.NEGATIVE_INFINITY) return undefined;
  return pages[ids.lastIndexOf(top)];
}

// Shared helpers of the UI tests (rulebook 702.4): the cursor is visible in the videos, interaction runs at human speed, and every
// step leaves a screenshot in the report. The delays live here and nowhere else; the specs call these helpers.
import type { BrowserContext, Locator, Page, TestInfo } from '@playwright/test';

/** Pauses of a person at the screen, in milliseconds. */
export const PAUSE = {
  afterNavigation: 1000,
  aroundClick: 400,
  betweenFields: 300,
  afterSubmit: 1500,
  afterScroll: 750,
  keystroke: 400,
} as const;

const wait = (page: Page, ms: number) => page.waitForTimeout(ms);

/** An overlay with a pointer and a ripple on every click, injected into every page of the page/context (call it before the first goto). */
export async function installCursor(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript(() => {
    const install = (): void => {
      if (document.getElementById('pw-cursor')) return;
      const cursor = document.createElement('div');
      cursor.id = 'pw-cursor';
      cursor.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;width:22px;height:22px;margin:-3px 0 0 -3px;'
        + 'background:url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'22\' height=\'22\'><path d=\'M2 2 L2 18 L7 13 L11 21 L14 19.5 L10 12 L17 12 Z\' fill=\'black\' stroke=\'white\' stroke-width=\'1.5\'/></svg>") no-repeat;'
        + 'left:0;top:0;transition:left 60ms linear,top 60ms linear';
      document.documentElement.appendChild(cursor);
      document.addEventListener('mousemove', (e) => { cursor.style.left = `${e.clientX}px`; cursor.style.top = `${e.clientY}px`; }, true);
      document.addEventListener('mousedown', (e) => {
        const ripple = document.createElement('div');
        ripple.style.cssText = `position:fixed;z-index:2147483646;pointer-events:none;left:${e.clientX - 18}px;top:${e.clientY - 18}px;`
          + 'width:36px;height:36px;border-radius:50%;border:3px solid #e8453c;opacity:.9;transition:transform 400ms ease-out,opacity 400ms ease-out';
        document.documentElement.appendChild(ripple);
        requestAnimationFrame(() => { ripple.style.transform = 'scale(1.8)'; ripple.style.opacity = '0'; });
        setTimeout(() => ripple.remove(), 500);
      }, true);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
  });
}

/** Open a URL and give the page a person's moment to be looked at. */
export async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await wait(page, PAUSE.afterNavigation);
}

/** Move the pointer to the element in steps, so the video shows the way, then click. */
export async function click(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 15 });
  await wait(page, PAUSE.aroundClick);
  await target.click();
  await wait(page, PAUSE.aroundClick);
}

/** Click into a field and type key by key. */
export async function type(page: Page, target: Locator, text: string): Promise<void> {
  await click(page, target);
  await target.clear();
  await target.pressSequentially(text, { delay: PAUSE.keystroke });
  await wait(page, PAUSE.betweenFields);
}

/** Press the button that submits and wait for the result to settle. */
export async function submit(page: Page, button: Locator): Promise<void> {
  await click(page, button);
  await wait(page, PAUSE.afterSubmit);
}

const counters = new WeakMap<TestInfo, number>();

/** A screenshot of the current state, attached to the test and so to the report: step-1-<label>.png, step-2-... */
export async function step(page: Page, info: TestInfo, label: string): Promise<void> {
  const n = (counters.get(info) ?? 0) + 1;
  counters.set(info, n);
  const body = await page.screenshot();
  await info.attach(`step-${n}-${label}`, { body, contentType: 'image/png' });
}

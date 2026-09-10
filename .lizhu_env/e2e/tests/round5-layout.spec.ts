/**
 * LOCAL E2E ONLY - NOT PART OF THE PACKAGE, NOT RUN BY `vitest`.
 *
 * This suite needs a real Chromium: it drives the round-5 layout fix in a
 * browser, because jsdom cannot lay out (inactive panel taken out of the
 * layout; only the README row scrolls). `@playwright/test` is not a dependency
 * of this package, so `vitest.config.ts` excludes `.lizhu_env/**` outright -
 * running the unit suite (`npm test` / `vitest run`) never collects this file.
 *
 * How to run it (from this directory, `.lizhu_env/e2e/`):
 *   1. install the local E2E dependencies once: `npm install`
 *   2. install the browser once:                  `npx playwright install chromium`
 *   3. run:                                       `npx playwright test tests/round5-layout.spec.ts`
 * `playwright.config.ts` starts its own Vite dev server (port 5199, `index.html`
 * + `main.tsx` replicating the settings shell) and writes `shots/` and
 * `test-results/`. Keep this directory out of git (`.gitignore`: `.lizhu_env/`).
 *
 * 离朱 independent E2E verification (round 5 layout fix):
 * a real Chromium lays out the SAME component + CSS module as production.
 * jsdom cannot do layout, so this is the only place where the two claims of
 * this round (inactive panel out of the layout; only the README row scrolls)
 * can actually be observed.
 */
import { expect, test } from '@playwright/test'

type Box = { sh: number; ch: number; top: number; bottom: number }

async function metrics(locator: ReturnType<typeof test['info']> extends never ? never : any): Promise<Box> {
  return locator.evaluate((el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    return { sh: el.scrollHeight, ch: el.clientHeight, top: r.top, bottom: r.bottom }
  })
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('[data-market-page]')).toBeVisible()
})

test('inactive panel is taken out of the layout instead of stacking', async ({ page }) => {
  const panels = page.locator('[data-market-panel]')
  await expect(panels).toHaveCount(2)

  const hidden = page.locator('[data-market-panel="github"]')
  const shown = page.locator('[data-market-panel="local"]')
  await expect(shown).toBeVisible()
  await expect(hidden).toBeHidden()

  const computed = await hidden.evaluate((el: HTMLElement) => ({
    display: getComputedStyle(el).display,
    height: el.getBoundingClientRect().height,
  }))
  expect(computed.display).toBe('none')
  expect(computed.height).toBe(0)

  // The page must be as tall as its container: a stacked panel would inflate it.
  const shell = await page.locator('#host').evaluate((el: HTMLElement) => el.getBoundingClientRect().height)
  const pageBox = await metrics(page.locator('[data-market-page]'))
  const hostBox = await page.locator('#host').evaluate((el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    return { inner: r.height - 32 - 4 }
  })
  expect(pageBox.ch).toBeLessThanOrEqual(Math.round(hostBox.inner) + 1)
  expect(pageBox.sh).toBeLessThanOrEqual(pageBox.ch + 1)
  void shell

  const doc = await page.evaluate(() => ({
    sh: document.documentElement.scrollHeight,
    ch: document.documentElement.clientHeight,
  }))
  expect(doc.sh).toBeLessThanOrEqual(doc.ch + 1)
})

test('exactly one panel occupies layout space after switching in both directions', async ({ page }) => {
  const occupied = (): Promise<number> => page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-market-panel]'))
      .filter(el => el.getBoundingClientRect().height > 0).length)

  expect(await occupied()).toBe(1)
  await page.click('[data-market-tab="github"]')
  await expect(page.locator('[data-market-panel="github"]')).toBeVisible()
  expect(await occupied()).toBe(1)
  expect(await page.locator('[data-market-panel="local"]').evaluate((el: HTMLElement) => el.getBoundingClientRect().height)).toBe(0)
  await page.click('[data-market-tab="local"]')
  await expect(page.locator('[data-market-panel="local"]')).toBeVisible()
  expect(await occupied()).toBe(1)
})

test('the result list is the only scrolling row of the list view', async ({ page }) => {
  await page.click('[data-market-tab="github"]')
  await page.fill('[data-market-search-input]', 'acme')
  await page.click('[data-market-search-submit]')

  const list = page.locator('[data-market-results]')
  await expect(list).toBeVisible()
  const listBox = await metrics(list)
  expect(listBox.sh).toBeGreaterThan(listBox.ch)

  await list.evaluate((el: HTMLElement) => { el.scrollTop = 240 })
  expect(await list.evaluate((el: HTMLElement) => el.scrollTop)).toBeGreaterThan(0)

  for (const selector of ['[data-market-scroll]', '[data-market-panel="github"]', '[data-market-page]']) {
    const box = await metrics(page.locator(selector))
    expect(box.sh, selector).toBeLessThanOrEqual(box.ch + 1)
  }
  const doc = await page.evaluate(() => ({ sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight }))
  expect(doc.sh).toBeLessThanOrEqual(doc.ch + 1)
})

test('the detail head stays pinned while only the README row scrolls', async ({ page }) => {
  await page.click('[data-market-tab="github"]')
  await page.fill('[data-market-search-input]', 'acme')
  await page.click('[data-market-search-submit]')
  await page.click('[data-row-details]')

  const readme = page.locator('[data-readme-section]')
  await expect(readme).toBeVisible()
  const readmeBox = await metrics(readme)
  expect(readmeBox.sh).toBeGreaterThan(readmeBox.ch)

  const pinnedSelectors = ['[data-github-detail-header]', '[data-detail-header]', '[data-ref-picker]', '[data-ref-install]']
  const before: number[] = []
  for (const selector of pinnedSelectors) before.push((await page.locator(selector).boundingBox())?.y ?? -1)

  await readme.evaluate((el: HTMLElement) => { el.scrollTop = 900 })
  expect(await readme.evaluate((el: HTMLElement) => el.scrollTop)).toBeGreaterThan(0)

  for (const [index, selector] of pinnedSelectors.entries()) {
    const after = (await page.locator(selector).boundingBox())?.y ?? -2
    expect(Math.abs(after - (before[index] as number)), `${selector} moved`).toBeLessThan(1)
  }

  for (const selector of ['[data-detail-scroll]', '[data-detail-view]', '[data-market-scroll]', '[data-market-panel="github"]', '[data-market-page]']) {
    const box = await metrics(page.locator(selector))
    expect(box.sh, selector).toBeLessThanOrEqual(box.ch + 1)
  }
})

test('ADVERSARIAL short settings container: the list must not overflow its zone', async ({ page }) => {
  // A short (but perfectly legitimate) host container: the settings shell can be
  // small, and 46vh is viewport-derived, never container-derived.
  await page.evaluate(() => {
    const host = document.getElementById('host') as HTMLElement
    host.style.flex = 'none'
    host.style.height = '320px'
  })
  await page.click('[data-market-tab="github"]')
  await page.fill('[data-market-search-input]', 'acme')
  await page.click('[data-market-search-submit]')
  await expect(page.locator('[data-market-results]')).toBeVisible()

  const zone = await metrics(page.locator('[data-market-scroll]'))
  const list = await metrics(page.locator('[data-market-results]'))
  const pageBox = await metrics(page.locator('[data-market-page]'))
  const vh = await page.evaluate(() => window.innerHeight)

  console.log(`ADVERSARIAL zone=${JSON.stringify(zone)} list=${JSON.stringify(list)} page=${JSON.stringify(pageBox)} vh=${String(vh)}`)
  // The list row must fit inside the zone that clips it.
  expect(list.bottom, `list bottom ${String(list.bottom)} vs zone bottom ${String(zone.bottom)}`).toBeLessThanOrEqual(zone.bottom + 1)
  expect(list.ch).toBeLessThanOrEqual(zone.ch + 1)
  // And the page must not grow past its container.
  expect(pageBox.sh).toBeLessThanOrEqual(pageBox.ch + 1)
})

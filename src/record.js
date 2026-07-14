import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const DESKTOP_VIEWPORT = { width: 1920, height: 1080 };
// Exact 9:16 in CSS pixels; narrow enough that responsive sites serve their mobile layout.
const MOBILE_VIEWPORT = { width: 540, height: 960 };

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const END_HOLD_MS = 1500;
const MAX_SCROLL_VIEWPORTS = 4;

// Known consent-manager accept buttons (OneTrust, Cookiebot, Didomi, Usercentrics,
// Quantcast, Google Funding Choices, cookieconsent), then a generic text fallback.
const CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '#didomi-notice-agree-button',
  '[data-testid="uc-accept-all-button"]',
  '#qc-cmp2-ui button[mode="primary"]',
  '.fc-cta-consent',
  '.cc-allow',
  '.cc-accept-all',
  '.js-accept-cookies',
];

// Accept OR reject wording — either one makes the banner go away, which is all we need.
const CONSENT_TEXT =
  /^(accept( all)?( cookies)?|allow all( cookies)?|agree( & continue)?|i agree|i accept|got it|reject all( cookies)?|(only )?necessary cookies( only)?)$/i;

async function dismissCookieBanners(page, settleMs = 800) {
  // Banners often animate in after load.
  if (settleMs > 0) await page.waitForTimeout(settleMs);
  for (const frame of page.frames()) {
    for (const selector of CONSENT_SELECTORS) {
      const button = await frame.$(selector).catch(() => null);
      if (button && (await button.isVisible().catch(() => false))) {
        await button.click({ timeout: 1000 }).catch(() => {});
        await page.waitForTimeout(500);
        return;
      }
    }
    const clicked = await frame
      .evaluate((pattern) => {
        const re = new RegExp(pattern, 'i');
        for (const el of document.querySelectorAll('button, [role="button"], a')) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && re.test(el.textContent.trim())) {
            el.click();
            return true;
          }
        }
        return false;
      }, CONSENT_TEXT.source)
      .catch(() => false);
    if (clicked) {
      await page.waitForTimeout(500);
      return;
    }
  }
}

// Utility/legal pages that make for a boring demo — skipped during discovery.
const SUBPAGE_EXCLUDE = /(login|log-in|signin|sign-in|signup|sign-up|register|account|cart|basket|checkout|privacy|terms|cookie|legal|search|sitemap)/i;

/** Same-origin nav links worth showing, best (header/nav) first. */
async function discoverSubpages(page, count) {
  const hrefs = await page
    .evaluate(() =>
      [
        ...document.querySelectorAll('header a[href], nav a[href], [role="navigation"] a[href]'),
        ...document.querySelectorAll('a[href]'),
      ].map((a) => a.href),
    )
    .catch(() => []);
  const current = new URL(page.url());
  const normalize = (p) => p.replace(/\/+$/, '') || '/';
  const seen = new Set([normalize(current.pathname)]);
  const out = [];
  for (const href of hrefs) {
    let target;
    try {
      target = new URL(href);
    } catch {
      continue;
    }
    const path = normalize(target.pathname);
    if (target.origin !== current.origin || seen.has(path) || path === '/' || SUBPAGE_EXCLUDE.test(path)) continue;
    seen.add(path);
    out.push(target.origin + target.pathname);
    if (out.length >= count) break;
  }
  return out;
}

/** Hold on top, ease-in-out scroll toward the bottom, hold at the end. */
async function scrollThrough(page, { holdMs, scrollMs, endHoldMs, maxScroll }) {
  await page.waitForTimeout(holdMs);
  // Second pass for banners that pop in late (e.g. injected after an ad/consent script loads).
  await dismissCookieBanners(page, 0);
  await page.evaluate(
    async ({ durationMs, maxScroll }) => {
      const doc = document.documentElement;
      const target = Math.min(doc.scrollHeight - window.innerHeight, maxScroll);
      if (target <= 0) {
        await new Promise((r) => setTimeout(r, durationMs));
        return;
      }
      const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
      const start = performance.now();
      await new Promise((resolve) => {
        const step = (now) => {
          const t = Math.min(1, (now - start) / durationMs);
          // behavior:'instant' overrides CSS scroll-behavior:smooth, which would
          // otherwise turn every step into a restarted animation that never moves.
          window.scrollTo({ top: target * easeInOut(t), behavior: 'instant' });
          if (t < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
    },
    { durationMs: scrollMs, maxScroll },
  );
  await page.waitForTimeout(endHoldMs);
}

/**
 * Records a site demo (load → hero hold → smooth scroll, then the same for
 * each additional subpage) via CDP screencast: Chrome streams timestamped JPEG
 * frames at 2x device pixels, far sharper than Playwright's built-in
 * low-bitrate VP8 recorder.
 * Returns the path of an ffconcat list describing the captured frames.
 */
export async function record({ url, orientation, style, duration, hold, pages = 1, videoDir }) {
  const isMobile = orientation === 'vertical' && style === 'mobile';
  const viewport = isMobile ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;

  // Full Chromium in new-headless mode: renders like desktop Chrome (fonts, GPU rasterization)
  // and identifies normally, unlike the stripped-down headless shell.
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 2,
      ...(isMobile && { isMobile: true, hasTouch: true, userAgent: MOBILE_UA }),
    });
    // Google One Tap sign-in prompts overlay the page in recordings; block them outright.
    await context.route('**://accounts.google.com/gsi/**', (route) => route.abort());
    const page = await context.newPage();

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    // Best effort: give slow sites a chance to settle without hanging forever.
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

    const title = await page.title().catch(() => '');
    if (/just a moment|attention required|security verification|access denied/i.test(title)) {
      console.warn(
        `Warning: "${title}" — the site served a bot challenge instead of its landing page. ` +
        'The video will show the challenge screen. Try again later or from a different network.',
      );
    }

    await dismissCookieBanners(page);

    // Find nav links up front (before capture) so navigation later is instant.
    const subpages = pages > 1 ? await discoverSubpages(page, (pages - 1) * 3) : [];
    if (pages > 1 && subpages.length < pages - 1) {
      console.warn(`Warning: only found ${subpages.length} subpage link(s) — the video will cover ${subpages.length + 1} page(s).`);
    }

    // Capture starts here — the load/banner phase is simply never recorded.
    const frames = []; // { file, ts } in capture order
    const writes = [];
    const cdp = await context.newCDPSession(page);
    cdp.on('Page.screencastFrame', (event) => {
      const file = `frame-${String(frames.length).padStart(6, '0')}.jpg`;
      frames.push({ file, ts: event.metadata.timestamp });
      writes.push(writeFile(join(videoDir, file), Buffer.from(event.data, 'base64')));
      cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 92,
      maxWidth: viewport.width * 2,
      maxHeight: viewport.height * 2,
    });

    const maxScroll = viewport.height * MAX_SCROLL_VIEWPORTS;
    // Subpages are over-collected as fallbacks for broken links; time is split
    // across the pages that will actually be shown.
    const plannedPages = Math.min(pages, subpages.length + 1);
    const segmentMs = (duration * 1000) / plannedPages;
    const visited = [page.url()];

    // Homepage: full hero hold; a short settle between pages, longer at the very end.
    await scrollThrough(page, {
      holdMs: hold * 1000,
      scrollMs: Math.max(2000, segmentMs - hold * 1000 - (plannedPages > 1 ? 800 : END_HOLD_MS)),
      endHoldMs: plannedPages > 1 ? 800 : END_HOLD_MS,
      maxScroll,
    });

    let remaining = pages - 1;
    for (const target of subpages) {
      if (remaining <= 0) break;
      try {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
      } catch {
        continue; // broken link — try the next candidate
      }
      remaining--;
      visited.push(target);
      const isLast = remaining === 0 || target === subpages.at(-1);
      await scrollThrough(page, {
        holdMs: 1200,
        scrollMs: Math.max(2000, segmentMs - 1200 - (isLast ? END_HOLD_MS : 800)),
        endHoldMs: isLast ? END_HOLD_MS : 800,
        maxScroll,
      });
    }

    await cdp.send('Page.stopScreencast').catch(() => {});
    const endTs = Date.now() / 1000; // same epoch as screencast frame timestamps
    await Promise.all(writes);
    await context.close();

    if (frames.length === 0) {
      throw new Error('No frames captured — the page never painted during recording.');
    }

    // ffconcat list: each frame shown until the next one's timestamp; the last
    // entry is repeated so its duration (until capture end) is honored.
    const lines = ['ffconcat version 1.0'];
    for (let i = 0; i < frames.length; i++) {
      const next = i + 1 < frames.length ? frames[i + 1].ts : endTs;
      lines.push(`file ${frames[i].file}`, `duration ${Math.max(0.001, next - frames[i].ts).toFixed(4)}`);
    }
    lines.push(`file ${frames.at(-1).file}`, '');
    const concatFile = join(videoDir, 'frames.ffconcat');
    await writeFile(concatFile, lines.join('\n'));
    return { concatFile, visited };
  } finally {
    await browser.close();
  }
}

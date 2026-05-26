// src/modules/browser.js
"use strict";
const { chromium } = require("playwright");
const config = require("../config");
const logger = require("../utils/logger");
const session = require("./session");
const { sleep } = require("../utils/human");

/**
 * Launch a Chromium with the latest known session.
 */
async function launch({ pullFresh = true } = {}) {
  if (pullFresh) {
    try {
      await session.pullRemoteSession();
    } catch (e) {
      logger.warn({ err: e.message }, "pull session failed");
    }
  }

  const browser = await chromium.launch({
    headless: config.browser.headless,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const storageState = session.hasLocalSession()
    ? session.localPath()
    : undefined;

  const ctx = await browser.newContext({
    storageState,
    locale: config.browser.locale,
    userAgent: config.browser.userAgent || undefined,
    viewport: { width: 1366, height: 820 },
    timezoneId: "Europe/Paris",
    extraHTTPHeaders: {
      "Accept-Language": `${config.browser.locale},en;q=0.7`,
    },
  });

  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = await ctx.newPage();
  return { browser, context: ctx, page };
}

/**
 * Visit a page that requires authentication and decide whether we're logged in.
 *
 * We hit /me — Facebook's "redirect to current user's profile" alias.
 * - If logged in → redirects to https://www.facebook.com/<username>
 * - If NOT logged in → redirects to https://www.facebook.com/login/
 *
 * This is a much stronger signal than checking the public landing page.
 *
 * Returns 'ok' | 'login_required' | 'checkpoint' | 'unknown'.
 */
async function checkSession(page) {
  try {
    await page.goto("https://www.facebook.com/me", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
  } catch (e) {
    logger.warn({ err: e.message }, "checkSession: goto failed");
    return "unknown";
  }

  // Give the page a bit more time to settle (slow datacenter IPs)
  await sleep(4000);

  const url = page.url();
  const title = await page.title().catch(() => "");

  logger.info({ url, title }, "checkSession: landed");

  // Hard signals from URL
  if (/\/checkpoint/i.test(url)) return "checkpoint";
  if (/\/login/i.test(url)) return "login_required";

  // /me redirected somewhere else AND it's not /login or /checkpoint → logged in
  // (typically https://www.facebook.com/<username> or /profile.php?id=...)
  if (!/\/me\/?$/.test(url)) {
    logger.info(
      { finalUrl: url },
      "checkSession: /me redirected to profile, logged in",
    );
    return "ok";
  }

  // If we're still on /me, double-check with content indicators
  const indicators = [
    '[aria-label*="Create a post" i]',
    '[aria-label*="Créer une publication" i]',
    '[aria-label*="What\'s on your mind" i]',
    'div[role="banner"] svg[aria-label]',
    '[role="navigation"][aria-label*="acco" i]',
    'a[aria-label*="Profile" i]',
    'a[aria-label*="Profil" i]',
    '[data-testid="feed_story_region"]',
    'div[role="main"]',
  ];
  for (const sel of indicators) {
    try {
      if (await page.locator(sel).first().isVisible({ timeout: 1500 })) {
        return "ok";
      }
    } catch {
      /* keep trying */
    }
  }

  return "unknown";
}

module.exports = { launch, checkSession };
//v2

// src/modules/browser.js
"use strict";
const { chromium } = require("playwright");
const config = require("../config");
const logger = require("../utils/logger");
const session = require("./session");
const { sleep } = require("../utils/human");

/**
 * Launch a Chromium with the latest known session.
 * Returns { browser, context, page }.
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
 * Visit facebook.com and decide whether we're logged in.
 * Returns 'ok' | 'login_required' | 'checkpoint' | 'unknown'.
 *
 * Logic (aligned with loginWithCredentials):
 *  1. If URL contains /login or /checkpoint → not ok.
 *  2. If any logged-in indicator is visible → ok.
 *  3. Fallback: if we navigated to a non-login, non-checkpoint URL,
 *     and the page has a body, assume we're logged in.
 *     (Same heuristic as loginWithCredentials.)
 */
async function checkSession(page) {
  try {
    await page.goto("https://www.facebook.com/", {
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

  // Log what we see — helps debugging when this gets stuck
  logger.info({ url, title }, "checkSession: landed");

  if (/\/checkpoint/i.test(url)) return "checkpoint";
  if (/\/login/i.test(url)) return "login_required";

  // Try a broader set of indicators (same as loginWithCredentials)
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

  // Fallback: if we're not on /login or /checkpoint and the page has a body,
  // assume we're logged in. Same heuristic used in loginWithCredentials.
  const finalUrl = page.url();
  if (!/\/(login|checkpoint)/i.test(finalUrl)) {
    logger.info(
      { finalUrl },
      "checkSession: no indicator matched but URL is non-login, assuming ok",
    );
    return "ok";
  }

  return "unknown";
}

module.exports = { launch, checkSession };

// src/modules/browser.js
"use strict";
const { chromium } = require("playwright");
const config = require("../config");
const logger = require("../utils/logger");
const session = require("./session");
const { sleep } = require("../utils/human");

/**
 * Launch a Chromium with the latest known session.
 * Tuned to keep memory low (Render free tier = 512 MB).
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
      // Stealth / anti-bot
      "--disable-blink-features=AutomationControlled",

      // Required for containers without proper IPC namespace
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-setuid-sandbox",

      // Memory savers — significantly reduce Chromium's footprint
      "--single-process", // Run renderer in same process (saves ~100MB)
      "--no-zygote", // Skip the zygote process
      "--disable-gpu", // No GPU in headless
      "--disable-accelerated-2d-canvas",
      "--disable-software-rasterizer",

      // Disable heavy / unneeded features
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-breakpad",
      "--disable-client-side-phishing-detection",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-domain-reliability",
      "--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process,TranslateUI",
      "--disable-hang-monitor",
      "--disable-ipc-flooding-protection",
      "--disable-popup-blocking",
      "--disable-prompt-on-repost",
      "--disable-renderer-backgrounding",
      "--disable-sync",
      "--metrics-recording-only",
      "--mute-audio",
      "--no-default-browser-check",
      "--no-first-run",
      "--no-pings",

      // Reduce memory pressure
      "--memory-pressure-off",
      "--max_old_space_size=400",
    ],
  });

  const storageState = session.hasLocalSession()
    ? session.localPath()
    : undefined;

  const ctx = await browser.newContext({
    storageState,
    locale: config.browser.locale,
    userAgent: config.browser.userAgent || undefined,
    viewport: { width: 1280, height: 720 }, // smaller viewport = less rendering
    timezoneId: "Europe/Paris",
    extraHTTPHeaders: {
      "Accept-Language": `${config.browser.locale},en;q=0.7`,
    },
    // Block heavy resources to save memory + bandwidth
    // (Note: FB still works without videos/fonts)
  });

  // Block heavy resources (videos, fonts) to reduce memory consumption
  await ctx.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (type === "media" || type === "font") {
      return route.abort();
    }
    return route.continue();
  });

  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = await ctx.newPage();
  return { browser, context: ctx, page };
}

/**
 * Visit /me and decide whether we're logged in.
 * Logged in → redirected to profile URL.
 * Not logged in → redirected to /login.
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

  await sleep(4000);

  const url = page.url();
  const title = await page.title().catch(() => "");

  logger.info({ url, title }, "checkSession: landed");

  if (/\/checkpoint/i.test(url)) return "checkpoint";
  if (/\/login/i.test(url)) return "login_required";

  if (!/\/me\/?$/.test(url)) {
    logger.info(
      { finalUrl: url },
      "checkSession: /me redirected to profile, logged in",
    );
    return "ok";
  }

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
//v4

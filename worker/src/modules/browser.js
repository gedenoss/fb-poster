"use strict";
const { chromium } = require("playwright");
const config = require("../config");
const logger = require("../utils/logger");
const session = require("./session");
const { sleep } = require("../utils/human");

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
    ...(config.browser.executablePath ? { executablePath: config.browser.executablePath } : {}),
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-setuid-sandbox",
      "--single-process",
      "--no-zygote",
      "--disable-gpu",
      "--disable-accelerated-2d-canvas",
      "--disable-software-rasterizer",
      "--disable-gpu-rasterization",
      "--disable-2d-canvas-image-chromium",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-breakpad",
      "--disable-client-side-phishing-detection",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-domain-reliability",
      "--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process,TranslateUI,BlinkGenPropertyTrees",
      "--disable-hang-monitor",
      "--disable-ipc-flooding-protection",
      "--disable-popup-blocking",
      "--disable-prompt-on-repost",
      "--disable-renderer-backgrounding",
      "--disable-sync",
      "--disable-translate",
      "--metrics-recording-only",
      "--mute-audio",
      "--no-default-browser-check",
      "--no-first-run",
      "--no-pings",
      "--password-store=basic",
      "--use-mock-keychain",
      "--window-size=1024,768",
    ],
  });

  const storageState = session.hasLocalSession() ? session.localPath() : undefined;

  const ctx = await browser.newContext({
    storageState,
    locale: config.browser.locale,
    userAgent: config.browser.userAgent || undefined,
    viewport: { width: 1024, height: 768 },
    timezoneId: "Europe/Paris",
    extraHTTPHeaders: { "Accept-Language": `${config.browser.locale},en;q=0.7` },
    serviceWorkers: "block",
  });

  await ctx.route("**/*", (route) => {
    const req = route.request();
    const type = req.resourceType();
    const url = req.url();

    if (type === "media" || type === "font" || type === "image") {
      return route.abort();
    }
    if (
      /\b(analytics|tracking|telemetry|metrics|beacon|pixel|adservice|ads)\b/i.test(url) ||
      /\.(mp4|webm|ogg|m4a|m4v|mov)(\?|$)/i.test(url) ||
      /facebook\.com\/(rsrc\.php|tr|tr\/|ajax\/bz|ajax\/bnzai|ajax\/log)/i.test(url)
    ) {
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
  if (!/\/me\/?$/.test(url)) return "ok";

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
      if (await page.locator(sel).first().isVisible({ timeout: 1500 })) return "ok";
    } catch {
      /* keep trying */
    }
  }

  return "unknown";
}

module.exports = { launch, checkSession };

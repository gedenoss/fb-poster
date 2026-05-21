// src/modules/browser.js
'use strict';
const { chromium } = require('playwright');
const config  = require('../config');
const logger  = require('../utils/logger');
const session = require('./session');
const { sleep } = require('../utils/human');

/**
 * Launch a Chromium with the latest known session.
 * Returns { browser, context, page }.
 */
async function launch({ pullFresh = true } = {}) {
  if (pullFresh) {
    try { await session.pullRemoteSession(); }
    catch (e) { logger.warn({ err: e.message }, 'pull session failed'); }
  }

  const browser = await chromium.launch({
    headless: config.browser.headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const storageState = session.hasLocalSession() ? session.localPath() : undefined;

  const ctx = await browser.newContext({
    storageState,
    locale:    config.browser.locale,
    userAgent: config.browser.userAgent || undefined,
    viewport:  { width: 1366, height: 820 },
    timezoneId: 'Europe/Paris',
    extraHTTPHeaders: { 'Accept-Language': `${config.browser.locale},en;q=0.7` },
  });

  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await ctx.newPage();
  return { browser, context: ctx, page };
}

/**
 * Visit facebook.com and decide whether we're logged in.
 * Returns 'ok' | 'login_required' | 'checkpoint' | 'unknown'.
 */
async function checkSession(page) {
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await sleep(2500);

  const url = page.url();
  if (/\/checkpoint/i.test(url)) return 'checkpoint';
  if (/\/login/i.test(url))      return 'login_required';

  const indicators = [
    '[aria-label*="Create a post" i]',
    '[aria-label*="Créer une publication" i]',
    'div[role="banner"] svg[aria-label]',
    '[role="navigation"][aria-label*="acco" i]',
  ];
  for (const sel of indicators) {
    try {
      if (await page.locator(sel).first().isVisible({ timeout: 2000 })) return 'ok';
    } catch { /* keep trying */ }
  }
  return 'unknown';
}

module.exports = { launch, checkSession };

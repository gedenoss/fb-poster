// src/modules/facebook.js
'use strict';
/**
 * Facebook UI automation.
 *
 * We avoid brittle CSS class selectors. Instead we rely on:
 *   - getByRole('button', { name: /publier|publish|publicar/i })
 *   - aria-label patterns
 *   - <input type="file"> hidden behind the photo button
 *
 * Patterns cover FR / EN / ES.
 */
const logger = require('../utils/logger');
const human  = require('../utils/human');
const { retry } = require('../utils/retry');

const TIMEOUT = 30_000;

const RE_CREATE_POST    = /(create.*post|write.*someth|publier|écrire|publica|escribir)/i;
const RE_ATTACH_PHOTO   = /(photo|video|image|ajouter.*photo|añadir.*foto|adjuntar)/i;
const RE_PUBLISH        = /^(post|publish|publier|publicar)$/i;
const RE_POST_MENU      = /(actions for this post|options de la publication|more|plus|más opciones)/i;
const RE_DELETE         = /(move to (trash|recycle bin)|delete post|supprimer la publication|supprimer|delete|eliminar)/i;
const RE_CONFIRM_DELETE = /^(move|delete|supprimer|confirmer|eliminar|aceptar|confirmar)$/i;

// =============================================================================
// Helpers
// =============================================================================
async function findByRoleNameRegex(scope, role, regex, { timeout = TIMEOUT } = {}) {
  const loc = scope.getByRole(role, { name: regex });
  await loc.first().waitFor({ state: 'visible', timeout });
  return loc.first();
}

async function clickByRoleNameRegex(scope, role, regex, opts = {}) {
  const loc = await findByRoleNameRegex(scope, role, regex, opts);
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await human.sleep(human.randInt(250, 700));
  await loc.click({ delay: human.randInt(40, 140) });
}

async function dismissCookieBanner(page) {
  const candidates = [
    /allow all cookies/i,
    /accept all/i,
    /tout accepter/i,
    /autoriser tous les cookies/i,
    /aceptar todo/i,
  ];
  for (const re of candidates) {
    try {
      const btn = page.getByRole('button', { name: re }).first();
      if (await btn.isVisible({ timeout: 1500 })) {
        await btn.click({ delay: 60 });
        await human.sleep(800);
        return;
      }
    } catch { /* ignore */ }
  }
}

// =============================================================================
// LOGIN — used by /relogin
// =============================================================================
/**
 * Submit email + password on facebook.com/login and verify we land on the feed.
 *
 * @param {import('playwright').Page} page
 * @param {{ email: string, password: string }} creds
 * @returns {Promise<{ ok: boolean, reason?: 'bad_credentials' | 'checkpoint' | '2fa_required' | 'unknown' }>}
 */
async function loginWithCredentials(page, { email, password }) {
  if (!email || !password) return { ok: false, reason: 'bad_credentials' };

  await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await human.sleep(human.randInt(1500, 3000));
  await dismissCookieBanner(page);

  // Fill the email + password inputs. Facebook stable IDs: #email, #pass.
  const emailIn = page.locator('input#email, input[name="email"]').first();
  const passIn  = page.locator('input#pass, input[name="pass"]').first();
  await emailIn.waitFor({ state: 'visible', timeout: 15_000 });

  // Click the field then type humanly.
  await emailIn.click();
  await human.humanType(emailIn, email);
  await human.sleep(human.randInt(500, 1200));
  await passIn.click();
  await human.humanType(passIn, password);
  await human.sleep(human.randInt(600, 1400));

  // Submit.
  const submitBtn = page.locator('button[name="login"], button[type="submit"]#loginbutton, [data-testid="royal_login_button"]').first();
  if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await submitBtn.click({ delay: human.randInt(40, 120) });
  } else {
    await page.keyboard.press('Enter');
  }

  // Wait for navigation away from /login.
  await page.waitForLoadState('domcontentloaded', { timeout: 45_000 }).catch(() => {});
  await human.sleep(human.randInt(4000, 7000));

  const url = page.url();

  if (/\/checkpoint/i.test(url)) {
    // Could be 2FA prompt or device approval.
    const has2faInput = await page.locator('input[name="approvals_code"], input[autocomplete="one-time-code"]').count().catch(() => 0);
    return { ok: false, reason: has2faInput > 0 ? '2fa_required' : 'checkpoint' };
  }
  if (/\/login/i.test(url)) {
    return { ok: false, reason: 'bad_credentials' };
  }

  // Look for a logged-in indicator.
  const indicators = [
    '[aria-label*="Create a post" i]',
    '[aria-label*="Créer une publication" i]',
    'div[role="banner"] svg[aria-label]',
    '[role="navigation"][aria-label*="acco" i]',
  ];
  for (const sel of indicators) {
    if (await page.locator(sel).first().isVisible({ timeout: 3000 }).catch(() => false)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'unknown' };
}

/**
 * Submit a 2FA / approvals code on the checkpoint page.
 */
async function submitTwoFactor(page, code) {
  const input = page.locator('input[name="approvals_code"], input[autocomplete="one-time-code"]').first();
  await input.waitFor({ state: 'visible', timeout: 15_000 });
  await input.click();
  await human.humanType(input, code);
  await human.sleep(human.randInt(500, 1200));

  // Click "Continue".
  const re = /^(continue|continuer|next|suivant|continuar)$/i;
  try {
    await clickByRoleNameRegex(page, 'button', re, { timeout: 8000 });
  } catch {
    await page.keyboard.press('Enter');
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
  await human.sleep(human.randInt(3000, 5000));

  // Dismiss "remember this device" etc.
  const trustRe = /^(yes|oui|sí|continue|continuer|next|suivant)$/i;
  for (let i = 0; i < 3; i++) {
    try {
      await clickByRoleNameRegex(page, 'button', trustRe, { timeout: 3000 });
      await human.sleep(2000);
    } catch { break; }
  }

  return page.url().includes('/checkpoint') ? { ok: false, reason: 'still_checkpoint' } : { ok: true };
}

// =============================================================================
// Delete a published post
// =============================================================================
async function deletePost(page, postUrl) {
  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await human.sleep(human.randInt(2500, 4500));
    await dismissCookieBanner(page);

    await retry(async () => {
      await clickByRoleNameRegex(page, 'button', RE_POST_MENU, { timeout: 12_000 });
    }, { tries: 3, baseMs: 1500 });

    await human.sleep(human.randInt(700, 1500));

    await retry(async () => {
      try {
        await clickByRoleNameRegex(page, 'menuitem', RE_DELETE, { timeout: 8000 });
      } catch {
        await clickByRoleNameRegex(page, 'button', RE_DELETE, { timeout: 8000 });
      }
    }, { tries: 2, baseMs: 1000 });

    await human.sleep(human.randInt(800, 1600));

    await retry(async () => {
      await clickByRoleNameRegex(page, 'button', RE_CONFIRM_DELETE, { timeout: 10_000 });
    }, { tries: 2, baseMs: 1000 });

    await human.sleep(human.randInt(5000, 10_000));
    return { ok: true };
  } catch (err) {
    logger.warn({ postUrl, err: err.message }, 'deletePost failed');
    return { ok: false, error: err.message };
  }
}

// =============================================================================
// Post to a group
// =============================================================================
async function postToGroup(page, group, text, imagePaths) {
  await page.goto(group.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await human.sleep(human.randInt(3000, 6000));
  await dismissCookieBanner(page);
  await human.microScroll(page);
  await human.sleep(human.randInt(800, 1800));

  // Open the composer.
  await retry(async () => {
    try {
      await clickByRoleNameRegex(page, 'button', RE_CREATE_POST, { timeout: 8000 });
      return;
    } catch { /* fallback below */ }
    const placeholders = [
      /write something/i,
      /create.*post/i,
      /exprime-toi/i,
      /quoi de neuf/i,
      /écris quelque chose/i,
      /qué estás pensando/i,
    ];
    for (const re of placeholders) {
      const el = page.getByText(re).first();
      if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
        await el.click({ delay: human.randInt(40, 120) });
        return;
      }
    }
    throw new Error('composer not found');
  }, { tries: 3, baseMs: 1500 });

  const dialog = page.getByRole('dialog').first();
  await dialog.waitFor({ state: 'visible', timeout: 15_000 });
  await human.sleep(human.randInt(800, 1800));

  // Type the body.
  const textbox = dialog.getByRole('textbox').first();
  await textbox.waitFor({ state: 'visible', timeout: 10_000 });
  await textbox.click();
  await human.humanType(textbox, text);
  await human.sleep(human.randInt(800, 2000));

  // Upload images.
  if (imagePaths && imagePaths.length) {
    try {
      await clickByRoleNameRegex(dialog, 'button', RE_ATTACH_PHOTO, { timeout: 6000 });
      await human.sleep(human.randInt(700, 1500));
    } catch { /* file input may already be present */ }

    const fileInputs = await page.locator('input[type="file"]').all();
    let target = null;
    for (const inp of fileInputs) {
      const accept = (await inp.getAttribute('accept')) || '';
      if (/image|\*|jpg|png/i.test(accept) || accept === '') { target = inp; break; }
    }
    if (!target) throw new Error('no file input found in composer');
    await target.setInputFiles(imagePaths);
    await waitForUploadsToFinish(dialog);
  }

  await human.sleep(human.randInt(2000, 5000));

  const publishBtn = await findPublishButton(dialog);
  if (!publishBtn) throw new Error('publish button not found / disabled');

  await publishBtn.scrollIntoViewIfNeeded().catch(() => {});
  await human.sleep(human.randInt(400, 900));
  await publishBtn.click({ delay: human.randInt(60, 180) });

  await dialog.waitFor({ state: 'detached', timeout: 60_000 }).catch(() => {});
  await human.sleep(human.randInt(4000, 8000));

  return await captureMostRecentPostUrl(page, group.url);
}

async function waitForUploadsToFinish(dialog, timeoutMs = 90_000) {
  const start = Date.now();
  const progressSelectors = [
    'div[role="progressbar"]',
    'div[aria-label*="Uploading" i]',
    'div[aria-label*="En cours d" i]',
    'div[aria-label*="Subiendo" i]',
  ];
  while (Date.now() - start < timeoutMs) {
    let stillUploading = false;
    for (const sel of progressSelectors) {
      const cnt = await dialog.locator(sel).count().catch(() => 0);
      if (cnt > 0) { stillUploading = true; break; }
    }
    if (!stillUploading) {
      const previews = await dialog.locator('img[src*="scontent"], div[aria-label*="Remove"]').count().catch(() => 0);
      if (previews > 0) return;
      await human.sleep(800);
      const previews2 = await dialog.locator('img[src*="scontent"], div[aria-label*="Remove"]').count().catch(() => 0);
      if (previews2 > 0) return;
    }
    await human.sleep(800);
  }
  throw new Error('image upload did not finish within timeout');
}

async function findPublishButton(dialog) {
  const candidates = await dialog.getByRole('button', { name: RE_PUBLISH }).all();
  for (const btn of candidates) {
    const disabled = (await btn.getAttribute('aria-disabled')) === 'true';
    if (!disabled) return btn;
  }
  return null;
}

async function captureMostRecentPostUrl(page, groupUrl) {
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
    await human.sleep(human.randInt(1500, 3000));

    const article = page.getByRole('article').first();
    await article.waitFor({ state: 'visible', timeout: 10_000 });

    const link = article.locator('a[href*="/posts/"], a[href*="/permalink/"]').first();
    const href = await link.getAttribute('href', { timeout: 6000 });
    if (href) return new URL(href, 'https://www.facebook.com').toString().split('?')[0];
  } catch (e) {
    logger.warn({ err: e.message }, 'capture post URL failed; falling back');
  }
  return groupUrl;
}

module.exports = {
  deletePost,
  postToGroup,
  loginWithCredentials,
  submitTwoFactor,
};

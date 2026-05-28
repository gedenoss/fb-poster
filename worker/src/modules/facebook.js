"use strict";
const logger = require("../utils/logger");
const human = require("../utils/human");

const TIMEOUT = 30_000;

class SkippedPendingError extends Error {
  constructor() {
    super('already_pending');
    this.name = 'SkippedPendingError';
  }
}

const RE_PENDING = /en attente d.approbation de l.admin/i;
const RE_ATTACH_PHOTO = /(photo|video|image|ajouter.*photo|añadir.*foto|adjuntar)/i;
const RE_PUBLISH = /^(post|publish|publier|publicar)$/i;

async function hasPendingText(page) {
  return page.getByText(RE_PENDING).first().isVisible({ timeout: 1200 }).catch(() => false);
}

async function findByRoleNameRegex(
  scope,
  role,
  regex,
  { timeout = TIMEOUT } = {},
) {
  const loc = scope.getByRole(role, { name: regex });
  await loc.first().waitFor({ state: "visible", timeout });
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
      const btn = page.getByRole("button", { name: re }).first();
      if (await btn.isVisible({ timeout: 1500 })) {
        await btn.click({ delay: 60 });
        await human.sleep(800);
        return;
      }
    } catch {
      /* ignore */
    }
  }
}

async function loginWithCredentials(page, { email, password }) {
  if (!email || !password) return { ok: false, reason: "bad_credentials" };

  await page.goto("https://www.facebook.com/login", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await human.sleep(human.randInt(1500, 3000));
  await dismissCookieBanner(page);

  // Fill the email + password inputs. Facebook stable IDs: #email, #pass.
  const emailIn = page.locator('input#email, input[name="email"]').first();
  const passIn = page.locator('input#pass, input[name="pass"]').first();
  await emailIn.waitFor({ state: "visible", timeout: 15_000 });

  // Click the field then type humanly.
  await emailIn.click();
  await human.humanType(emailIn, email);
  await human.sleep(human.randInt(500, 1200));
  await passIn.click();
  await human.humanType(passIn, password);
  await human.sleep(human.randInt(600, 1400));

  // Submit.
  const submitBtn = page
    .locator(
      'button[name="login"], button[type="submit"]#loginbutton, [data-testid="royal_login_button"]',
    )
    .first();
  if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await submitBtn.click({ delay: human.randInt(40, 120) });
  } else {
    await page.keyboard.press("Enter");
  }

  // Wait for navigation away from /login.
  await page
    .waitForLoadState("domcontentloaded", { timeout: 45_000 })
    .catch(() => {});
  await human.sleep(human.randInt(4000, 7000));

  const url = page.url();

  if (/\/checkpoint/i.test(url)) {
    // Could be 2FA prompt or device approval.
    const has2faInput = await page
      .locator(
        'input[name="approvals_code"], input[autocomplete="one-time-code"]',
      )
      .count()
      .catch(() => 0);
    return {
      ok: false,
      reason: has2faInput > 0 ? "2fa_required" : "checkpoint",
    };
  }
  if (/\/login/i.test(url)) {
    return { ok: false, reason: "bad_credentials" };
  }

  // Look for a logged-in indicator.
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
      if (
        await page
          .locator(sel)
          .first()
          .isVisible({ timeout: 3000 })
          .catch(() => false)
      ) {
        return { ok: true };
      }
    } catch {
      /* continue */
    }
  }

  // Final check: if we're not on /login or /checkpoint, we're likely logged in
  const finalUrl = page.url();
  if (!/\/(login|checkpoint)/i.test(finalUrl)) {
    return { ok: true };
  }

  return { ok: false, reason: "unknown" };
}

async function submitTwoFactor(page, code) {
  const input = page
    .locator(
      'input[name="approvals_code"], input[autocomplete="one-time-code"]',
    )
    .first();
  await input.waitFor({ state: "visible", timeout: 15_000 });
  await input.click();
  await human.humanType(input, code);
  await human.sleep(human.randInt(500, 1200));

  // Click "Continue".
  const re = /^(continue|continuer|next|suivant|continuar)$/i;
  try {
    await clickByRoleNameRegex(page, "button", re, { timeout: 8000 });
  } catch {
    await page.keyboard.press("Enter");
  }
  await page
    .waitForLoadState("domcontentloaded", { timeout: 30_000 })
    .catch(() => {});
  await human.sleep(human.randInt(3000, 5000));

  // Dismiss "remember this device" etc.
  const trustRe = /^(yes|oui|sí|continue|continuer|next|suivant)$/i;
  for (let i = 0; i < 3; i++) {
    try {
      await clickByRoleNameRegex(page, "button", trustRe, { timeout: 3000 });
      await human.sleep(2000);
    } catch {
      break;
    }
  }

  return page.url().includes("/checkpoint")
    ? { ok: false, reason: "still_checkpoint" }
    : { ok: true };
}


async function postToGroup(page, group, text, imagePaths) {
  await page.goto(group.url, { waitUntil: "commit", timeout: 30_000 });
  await human.sleep(human.randInt(2000, 4000));
  await dismissCookieBanner(page);

  if (await hasPendingText(page)) {
    logger.info({ groupUrl: group.url }, "pending post detected, skipping group");
    throw new SkippedPendingError();
  }

  const composerPlaceholders = [
    /exprimez-vous/i,
    /exprime-toi/i,
    /écrivez quelque chose/i,
    /écris quelque chose/i,
    /quoi de neuf/i,
    /qu'avez-vous.*tête/i,
    /qu'est-ce que vous.*tête/i,
    /write something/i,
    /create.*post/i,
    /what's on your mind/i,
    /qué estás pensando/i,
  ];

  logger.info({ groupUrl: group.url }, "waiting for composer");

  let matchedRe = null;
  const startWait = Date.now();
  const MAX_WAIT_MS = 45_000;

  while (Date.now() - startWait < MAX_WAIT_MS) {
    for (const re of composerPlaceholders) {
      try {
        const el = page.getByText(re).first();
        if (await el.isVisible({ timeout: 400 }).catch(() => false)) {
          matchedRe = re;
          break;
        }
      } catch (_) {
        /* try next */
      }
    }
    if (matchedRe) break;
    await page.evaluate(() => window.scrollBy(0, 50)).catch(() => {});
    await human.sleep(1500);
  }

  const waitMs = Date.now() - startWait;
  logger.info(
    { waitMs, matched: matchedRe?.source || null },
    "finished waiting for group content",
  );

  if (!matchedRe) {
    throw new Error(`composer did not appear within ${MAX_WAIT_MS}ms`);
  }

  let opened = false;

  try {
    const el = page.getByText(matchedRe).first();
    await el.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await human.sleep(human.randInt(300, 700));
    await el.click({ delay: human.randInt(60, 160), timeout: 10_000 });
    opened = true;
    logger.info(
      { strategy: `text-direct:${matchedRe.source}` },
      "composer click attempted",
    );
  } catch (e) {
    logger.warn(
      { err: e.message },
      "direct text click failed, trying role=button",
    );
  }

  if (!opened) {
    try {
      const el = page
        .locator('[role="button"]', { hasText: matchedRe })
        .first();
      await el.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await human.sleep(human.randInt(300, 700));
      await el.click({
        delay: human.randInt(60, 160),
        force: true,
        timeout: 10_000,
      });
      opened = true;
      logger.info(
        { strategy: `role-button:${matchedRe.source}` },
        "composer click attempted (force)",
      );
    } catch (e) {
      logger.warn({ err: e.message }, "role=button click also failed");
    }
  }

  if (!opened) {
    try {
      const pageUrl = page.url();
      const buttonNames = await page.evaluate(() => {
        const buttons = Array.from(
          document.querySelectorAll('button, [role="button"]'),
        );
        return buttons
          .slice(0, 40)
          .map((b) => ({
            text: (b.innerText || "").trim().slice(0, 80),
            aria: (b.getAttribute("aria-label") || "").slice(0, 80),
          }))
          .filter((x) => x.text || x.aria);
      });
      logger.error(
        { pageUrl, buttonNames },
        "composer click exhausted all strategies",
      );
    } catch (_) {
      /* ignore */
    }
    throw new Error("composer not found (click failed)");
  }

  let scope = null;
  let textbox = null;

  try {
    const dialogPromise = page
      .getByRole("dialog")
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    const textboxPromise = page
      .getByRole("textbox")
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    await Promise.race([dialogPromise, textboxPromise]);

    const dialog = page.getByRole("dialog").first();
    if (await dialog.isVisible({ timeout: 500 }).catch(() => false)) {
      scope = dialog;
      textbox = dialog.getByRole("textbox").first();
      logger.info("composer opened in dialog mode");
    } else {
      scope = page;
      textbox = page.getByRole("textbox").first();
      logger.info("composer opened in inline mode");
    }
  } catch (e) {
    try {
      const url = page.url();
      const title = await page.title();
      logger.error(
        { url, title, err: e.message },
        "no composer dialog or textbox appeared after click",
      );
    } catch (_) {
      /* ignore */
    }
    throw new Error(`composer opened but no textbox/dialog: ${e.message}`);
  }

  await human.sleep(human.randInt(800, 1800));

  await textbox.click();
  await human.humanType(textbox, text);
  await human.sleep(human.randInt(800, 2000));

  if (imagePaths && imagePaths.length) {
    try {
      await clickByRoleNameRegex(scope, "button", RE_ATTACH_PHOTO, {
        timeout: 6000,
      });
      await human.sleep(human.randInt(700, 1500));
    } catch {
      /* file input may already be present */
    }

    const fileInputs = await page.locator('input[type="file"]').all();
    let target = null;
    for (const inp of fileInputs) {
      const accept = (await inp.getAttribute("accept")) || "";
      if (/image|\*|jpg|png/i.test(accept) || accept === "") {
        target = inp;
        break;
      }
    }
    if (!target) throw new Error("no file input found in composer");
    await target.setInputFiles(imagePaths);
    await waitForUploadsToFinish(scope === page ? page.locator("body") : scope);
  }

  await human.sleep(human.randInt(2000, 5000));

  const publishBtn = await findPublishButton(
    scope === page ? page.locator("body") : scope,
  );
  if (!publishBtn) throw new Error("publish button not found / disabled");

  await publishBtn.scrollIntoViewIfNeeded().catch(() => {});
  await human.sleep(human.randInt(400, 900));
  await publishBtn.click({ delay: human.randInt(60, 180) });

  if (scope !== page) {
    await scope.waitFor({ state: "detached", timeout: 60_000 }).catch(() => {});
  } else {
    await human.sleep(human.randInt(6000, 10_000));
  }
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
      const cnt = await dialog
        .locator(sel)
        .count()
        .catch(() => 0);
      if (cnt > 0) {
        stillUploading = true;
        break;
      }
    }
    if (!stillUploading) {
      const previews = await dialog
        .locator('img[src*="scontent"], div[aria-label*="Remove"]')
        .count()
        .catch(() => 0);
      if (previews > 0) return;
      await human.sleep(800);
      const previews2 = await dialog
        .locator('img[src*="scontent"], div[aria-label*="Remove"]')
        .count()
        .catch(() => 0);
      if (previews2 > 0) return;
    }
    await human.sleep(800);
  }
  throw new Error("image upload did not finish within timeout");
}

async function findPublishButton(dialog) {
  const candidates = await dialog
    .getByRole("button", { name: RE_PUBLISH })
    .all();
  for (const btn of candidates) {
    const disabled = (await btn.getAttribute("aria-disabled")) === "true";
    if (!disabled) return btn;
  }
  return null;
}

async function captureMostRecentPostUrl(page, groupUrl) {
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
    await human.sleep(human.randInt(1500, 3000));

    const article = page.getByRole("article").first();
    await article.waitFor({ state: "visible", timeout: 10_000 });

    const link = article
      .locator('a[href*="/posts/"], a[href*="/permalink/"]')
      .first();
    const href = await link.getAttribute("href", { timeout: 6000 });
    if (href)
      return new URL(href, "https://www.facebook.com").toString().split("?")[0];
  } catch (e) {
    logger.warn({ err: e.message }, "capture post URL failed; falling back");
  }
  return groupUrl;
}

module.exports = {
  postToGroup,
  loginWithCredentials,
  submitTwoFactor,
  SkippedPendingError,
};

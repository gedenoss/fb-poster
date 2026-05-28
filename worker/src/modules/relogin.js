'use strict';
const crypto  = require('crypto');
const logger  = require('../utils/logger');
const browser = require('./browser');
const session = require('./session');
const db      = require('./db');
const facebook = require('./facebook');
const { notify } = require('../utils/notify');

const pending = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000;

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

function gc() {
  const now = Date.now();
  for (const [k, v] of pending) {
    if (now - v.createdAt > PENDING_TTL_MS) {
      try { v.browser.close(); } catch (_) {}
      pending.delete(k);
    }
  }
}
setInterval(gc, 60_000).unref();

async function startLogin({ email, password }) {
  await session.clear();
  await db.setSessionState('relogging_in');

  const { browser: br, context, page } = await browser.launch({ pullFresh: false });

  try {
    const r = await facebook.loginWithCredentials(page, { email, password });

    if (r.ok) {
      await session.save(context);
      await db.setSessionState('ok', { checked: true });
      await br.close();
      await requeueAllNeedsLogin();
      await notify(':white_check_mark: Session Facebook restaurée — les jobs en attente repartent.');
      return { ok: true };
    }

    if (r.reason === '2fa_required') {
      const token = newToken();
      pending.set(token, { browser: br, context, page, createdAt: Date.now() });
      return { ok: false, reason: '2fa_required', pendingToken: token };
    }

    await br.close();
    await db.setSessionState('needs_login', { lastError: r.reason || 'unknown', checked: true });
    return { ok: false, reason: r.reason || 'unknown' };
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'startLogin crashed');
    try { await br.close(); } catch (_) {}
    await db.setSessionState('needs_login', { lastError: e.message, checked: true });
    return { ok: false, reason: 'unknown', detail: e.message };
  }
}

async function submitTwoFactor({ pendingToken, code }) {
  const entry = pending.get(pendingToken);
  if (!entry) return { ok: false, reason: 'expired_or_unknown' };
  pending.delete(pendingToken);

  try {
    const r = await facebook.submitTwoFactor(entry.page, code);
    if (r.ok) {
      await session.save(entry.context);
      await db.setSessionState('ok', { checked: true });
      await entry.browser.close();
      await requeueAllNeedsLogin();
      await notify(':white_check_mark: Session Facebook restaurée (2FA OK).');
      return { ok: true };
    }
    await entry.browser.close();
    await db.setSessionState('needs_login', { lastError: r.reason || 'still_checkpoint', checked: true });
    return { ok: false, reason: r.reason || 'still_checkpoint' };
  } catch (e) {
    logger.error({ err: e.message }, 'submitTwoFactor crashed');
    try { await entry.browser.close(); } catch (_) {}
    await db.setSessionState('needs_login', { lastError: e.message, checked: true });
    return { ok: false, reason: 'unknown', detail: e.message };
  }
}

async function requeueAllNeedsLogin() {
  const stuck = await db.getStuckNeedsLoginJobs();
  for (const j of stuck) await db.requeueJob(j.id);
  logger.info({ requeued: stuck.length }, 'requeued needs_login jobs');
}

module.exports = { startLogin, submitTwoFactor };

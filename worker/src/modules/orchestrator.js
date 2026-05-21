// src/modules/orchestrator.js
'use strict';
const logger  = require('../utils/logger');
const config  = require('../config');
const db      = require('./db');
const browser = require('./browser');
const session = require('./session');
const images  = require('./images');
const content = require('./content');
const facebook = require('./facebook');
const human    = require('../utils/human');
const { slack } = require('../utils/notify');

/**
 * Run a single posting job end-to-end.
 *
 * Returns:
 *   { status, posts }      on success / partial / failed
 *   { needsLogin: true }   on session-required failure (caller flips status to needs_login)
 */
async function runJob(job) {
  const jobId      = job.id;
  const propertyId = job.property_id;
  const t0 = Date.now();

  logger.info({ jobId, propertyId, testMode: config.testMode }, 'job start');
  await db.log({ jobId, action: 'job_start', message: `property=${propertyId} test=${config.testMode}` });

  const payload = await db.fetchPropertyPayload(propertyId);
  const groups  = await db.fetchActiveGroups({ city: payload.city });
  const previous = await db.fetchPublishedPosts(propertyId);

  if (groups.length === 0) {
    await db.log({ jobId, action: 'no_groups', level: 'warn' });
    return { status: 'completed', posts: [] };
  }

  const text       = content.buildPostText(payload);
  const localImgs  = await images.downloadMany(payload.images || []);
  await db.log({
    jobId,
    action: 'data_ready',
    meta:   { groups: groups.length, images: localImgs.length, hasText: !!text },
  });

  const { browser: br, context, page } = await browser.launch();
  const result = { status: 'completed', posts: [] };

  try {
    // ---- Session check ----
    const state = await browser.checkSession(page);
    await db.setSessionState(state === 'ok' ? 'ok' : 'needs_login', {
      checked: true,
      lastError: state === 'ok' ? null : state,
    });

    if (state !== 'ok') {
      await db.log({ jobId, action: 'session_invalid', level: 'warn', meta: { state } });
      await slack(
        `:warning: *Session Facebook expirée* (état: ${state}). Le job pour la propriété \`${propertyId}\` est en attente.`,
        { linkText: 'Se reconnecter', linkUrl: reloginLink() },
      );
      return { needsLogin: true };
    }
    await db.log({ jobId, action: 'session_ok' });

    // ---- Delete previous posts (only ours) ----
    for (const prev of previous) {
      if (!prev.post_url) continue;
      await db.log({ jobId, groupId: prev.group_id, action: 'delete_attempt', message: prev.post_url });
      const res = await facebook.deletePost(page, prev.post_url);
      await db.markPostDeleted(prev.id, { error: res.ok ? null : res.error });
      await db.log({
        jobId, groupId: prev.group_id,
        action: res.ok ? 'delete_ok' : 'delete_failed',
        level:  res.ok ? 'info' : 'warn',
        message: res.error || null,
      });
      await human.randomDelay(5000, 10_000);
    }

    // ---- Post in each group ----
    for (const group of groups) {
      await db.log({ jobId, groupId: group.id, action: 'post_start', message: group.name });
      try {
        const postUrl = await facebook.postToGroup(page, group, text, localImgs);
        const recId = await db.recordPublishedPost({
          propertyId, groupId: group.id, jobId, postUrl,
        });
        result.posts.push({
          group_id: group.id,
          group_name: group.name,
          post_url: postUrl,
          status: 'success',
          record_id: recId,
        });
        await db.log({ jobId, groupId: group.id, action: 'post_ok', message: postUrl });
      } catch (err) {
        logger.warn({ err: err.message, group: group.url }, 'post failed; skipping group');
        await db.recordFailedPost({
          propertyId, groupId: group.id, jobId, error: err.message,
        });
        result.posts.push({
          group_id: group.id, group_name: group.name,
          status: 'failed', error: err.message,
        });
        await db.log({
          jobId, groupId: group.id,
          action: 'post_failed', level: 'error', message: err.message,
        });
      }

      await human.idleMouseMove(page).catch(() => {});
      await human.microScroll(page).catch(() => {});
      await human.randomDelay();
    }

    // ---- Persist session ----
    try { await session.save(context); }
    catch (e) { logger.warn({ err: e.message }, 'session save failed'); }
  } finally {
    await br.close().catch(() => {});
    await images.cleanup().catch(() => {});
  }

  const failed = result.posts.filter((p) => p.status !== 'success').length;
  result.status =
    failed === result.posts.length && result.posts.length > 0 ? 'failed'
    : failed > 0 ? 'partial'
    : 'completed';

  logger.info({
    jobId,
    durationMs: Date.now() - t0,
    posts: result.posts.length,
    failed,
  }, 'job done');

  return result;
}

function reloginLink() {
  const base = (config.http.publicBaseUrl || '').replace(/\/$/, '');
  const tok  = config.http.reloginToken;
  if (!base) return null;
  return tok ? `${base}/relogin?token=${encodeURIComponent(tok)}` : `${base}/relogin`;
}

module.exports = { runJob, reloginLink };

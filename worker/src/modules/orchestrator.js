// src/modules/orchestrator.js
"use strict";
const logger = require("../utils/logger");
const config = require("../config");
const db = require("./db");
const browser = require("./browser");
const session = require("./session");
const images = require("./images");
const content = require("./content");
const facebook = require("./facebook");
const { SkippedPendingError } = facebook;
const human = require("../utils/human");
const { slack } = require("../utils/notify");

/**
 * Run a single posting job end-to-end.
 *
 * Returns:
 *   { status, posts }      on success / partial / failed
 *   { needsLogin: true }   on session-required failure (caller flips status to needs_login)
 */
async function runJob(job) {
  const jobId = job.id;
  const propertyId = job.property_id;
  const t0 = Date.now();

  logger.info({ jobId, propertyId, testMode: config.testMode }, "job start");
  await db.log({
    jobId,
    action: "job_start",
    message: `property=${propertyId} test=${config.testMode}`,
  });

  const payload = await db.fetchPropertyPayload(propertyId);
  const allGroups = await db.fetchActiveGroups({ city: payload.city });
  const groups = allGroups.slice(0, config.loop.maxGroupsPerJob);
  const previous = await db.fetchPublishedPosts(propertyId);

  if (groups.length === 0) {
    await db.log({ jobId, action: "no_groups", level: "warn" });
    return { status: "completed", posts: [] };
  }

  const text = content.buildPostText(payload);
  const localImgs = await images.downloadMany(payload.images || []);
  await db.log({
    jobId,
    action: "data_ready",
    meta: { groups: groups.length, images: localImgs.length, hasText: !!text },
  });

  let { browser: br, context, page } = await browser.launch();
  const result = { status: "completed", posts: [] };

  try {
    // ---- Session check ----
    const state = await browser.checkSession(page);
    await db.setSessionState(state === "ok" ? "ok" : "needs_login", {
      checked: true,
      lastError: state === "ok" ? null : state,
    });

    if (state !== "ok") {
      await db.log({
        jobId,
        action: "session_invalid",
        level: "warn",
        meta: { state },
      });
      await slack(
        `:warning: *Session Facebook expirée* (état: ${state}). Le job pour la propriété \`${propertyId}\` est en attente.`,
        { linkText: "Se reconnecter", linkUrl: reloginLink() },
      );
      return { needsLogin: true };
    }
    await db.log({ jobId, action: "session_ok" });

    // ---- Delete previous posts (DISABLED for now) ----
    // Pour l'instant on saute la suppression — on validera le posting d'abord
    // puis on rebranchera proprement avec une UI de confirmation.
    if (previous.length > 0) {
      await db.log({
        jobId,
        action: "delete_skipped",
        level: "info",
        message: `skipping deletion of ${previous.length} previous post(s) — flow simplified`,
        meta: { count: previous.length },
      });
    }

    // ---- Post in each group ----
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];

      // Recycle le browser tous les N groupes pour libérer la RAM
      if (i > 0 && i % config.loop.browserRecycleEvery === 0) {
        logger.info({ i }, "recyclage browser — libération RAM");
        try { await page.close(); } catch (_) {}
        try { await context.close(); } catch (_) {}
        try { await br.close(); } catch (_) {}
        if (global.gc) try { global.gc(); } catch (_) {}
        await human.sleep(3000);
        ({ browser: br, context, page } = await browser.launch({ pullFresh: false }));
      }

      await db.log({
        jobId,
        groupId: group.id,
        action: "post_start",
        message: group.name,
      });
      try {
        const postUrl = await facebook.postToGroup(
          page,
          group,
          text,
          localImgs,
        );
        const recId = await db.recordPublishedPost({
          propertyId,
          groupId: group.id,
          jobId,
          postUrl,
        });
        result.posts.push({
          group_id: group.id,
          group_name: group.name,
          post_url: postUrl,
          status: "success",
          record_id: recId,
        });
        await db.log({
          jobId,
          groupId: group.id,
          action: "post_ok",
          message: postUrl,
        });
      } catch (err) {
        if (err instanceof SkippedPendingError) {
          logger.info({ group: group.name }, "post annulé — publication déjà en attente");
          result.posts.push({
            group_id: group.id,
            group_name: group.name,
            status: "skipped",
            reason: "already_pending",
          });
          await db.log({ jobId, groupId: group.id, action: "post_skipped_pending", level: "info" });
        } else {
          logger.warn(
            { err: err.message, group: group.url },
            "post failed; skipping group",
          );
          await db.recordFailedPost({
            propertyId,
            groupId: group.id,
            jobId,
            error: err.message,
          });
          result.posts.push({
            group_id: group.id,
            group_name: group.name,
            status: "failed",
            error: err.message,
          });
          await db.log({
            jobId,
            groupId: group.id,
            action: "post_failed",
            level: "error",
            message: err.message,
          });
        }
      }

      await human.idleMouseMove(page).catch(() => {});
      await human.microScroll(page).catch(() => {});
      await human.randomDelay();

      // Délai long entre groupes pour lisser sur la durée et éviter le ban
      if (i < groups.length - 1) {
        logger.info({ delayMs: config.loop.groupDelayMs, next: groups[i + 1].name }, "pause entre groupes");
        await human.sleep(config.loop.groupDelayMs);
      }
    }

    // ---- Persist session ----
    try {
      await session.save(context);
    } catch (e) {
      logger.warn({ err: e.message }, "session save failed");
    }
  } finally {
    // Close all resources in order
    try {
      await page.close().catch(() => {});
    } catch (_) {}
    try {
      await context.close().catch(() => {});
    } catch (_) {}
    try {
      await br.close().catch(() => {});
    } catch (_) {}
    await images.cleanup().catch(() => {});

    // Wait a bit before returning to let OS free resources
    await human.sleep(500);
  }

  const failed = result.posts.filter((p) => p.status === "failed").length;
  const posted = result.posts.filter((p) => p.status === "success").length;
  result.status =
    failed > 0 && posted === 0
      ? "failed"
      : failed > 0
        ? "partial"
        : "completed";

  logger.info(
    {
      jobId,
      durationMs: Date.now() - t0,
      posts: result.posts.length,
      failed,
    },
    "job done",
  );

  // Force garbage collection if available
  if (global.gc) {
    try {
      global.gc();
      logger.debug("forced gc after job");
    } catch (_) {}
  }

  return result;
}

function reloginLink() {
  const base = (config.http.publicBaseUrl || "").replace(/\/$/, "");
  const tok = config.http.reloginToken;
  if (!base) return null;
  return tok
    ? `${base}/relogin?token=${encodeURIComponent(tok)}`
    : `${base}/relogin`;
}

module.exports = { runJob, reloginLink };

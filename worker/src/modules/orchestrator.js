"use strict";
const logger = require("../utils/logger");
const config = require("../config");
const db = require("./db");
const browser = require("./browser");
const session = require("./session");
const images = require("./images");
const content = require("./content");
const facebook = require("./facebook");
const { SkippedPendingError, RateLimitedError } = facebook;
const human = require("../utils/human");
const { notify } = require("../utils/notify");

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

  if (!(payload.availableRooms > 0)) {
    await db.log({ jobId, action: "no_available_rooms", level: "warn" });
    return { status: "failed", error: "no_available_rooms", posts: [] };
  }

  const allGroups = await db.fetchActiveGroups({ city: payload.city, zone: payload.zone });
  const groups = allGroups.slice(0, config.loop.maxGroupsPerJob);
  if (groups.length === 0) {
    await db.log({ jobId, action: "no_groups", level: "warn" });
    return { status: "completed", posts: [] };
  }

  const localImgs = await images.downloadMany(payload.images || []);
  const text = content.buildPostText(payload);
  await db.log({
    jobId,
    action: "data_ready",
    meta: { groups: groups.length, images: localImgs.length, hasText: !!text },
  });

  let { browser: br, context, page } = await browser.launch();
  const result = { status: "completed", posts: [] };

  try {
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
      await notify(
        `:warning: *Session Facebook expirée* (état: ${state}). Le job pour la propriété \`${propertyId}\` est en attente.`,
        { linkText: "Se reconnecter", linkUrl: reloginLink() },
      );
      return { needsLogin: true };
    }
    await db.log({ jobId, action: "session_ok" });

    await notify(`🚀 Job démarré — property \`${propertyId}\` — ${groups.length} groupe(s)`).catch(() => {});

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];

      if (i > 0 && i % config.loop.browserRecycleEvery === 0) {
        logger.info({ i }, "browser recycle");
        try { await session.save(context); } catch (e) { logger.warn({ err: e.message }, "session save before recycle failed"); }
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
        const postUrl = await facebook.postToGroup(page, group, text, localImgs);
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
        await db.log({ jobId, groupId: group.id, action: "post_ok", message: postUrl });
        await notify(`✅ ${group.name}${postUrl ? ` — ${postUrl}` : ""}`).catch(() => {});
      } catch (err) {
        if (err instanceof RateLimitedError) {
          logger.warn({ group: group.name }, "rate limited — stopping job");
          await db.log({ jobId, groupId: group.id, action: "rate_limited", level: "warn" });
          await notify(`⚠️ Facebook a limité le compte — job arrêté après ${result.posts.filter(p => p.status === "success").length} groupe(s).`).catch(() => {});
          result.posts.push({ group_id: group.id, group_name: group.name, status: "failed", error: "rate_limited" });
          break;
        } else if (err.message === "session_expired") {
          logger.warn({ group: group.name }, "session expirée détectée mid-job");
          await notify(
            `:warning: *Session Facebook expirée* détectée pendant le job. Le job pour la propriété \`${propertyId}\` est en attente.`,
            { linkText: "Se reconnecter", linkUrl: reloginLink() },
          );
          return { needsLogin: true };
        } else if (err instanceof SkippedPendingError) {
          logger.info({ group: group.name }, "post annulé — publication déjà en attente");
          result.posts.push({
            group_id: group.id,
            group_name: group.name,
            status: "skipped",
            reason: "already_pending",
          });
          await db.log({ jobId, groupId: group.id, action: "post_skipped_pending", level: "info" });
          await notify(`⏭ ${group.name} — déjà en attente d'approbation`).catch(() => {});
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
          await db.log({ jobId, groupId: group.id, action: "post_failed", level: "error", message: err.message });
          await notify(`❌ ${group.name} — ${err.message}`).catch(() => {});
        }
      }

      await human.idleMouseMove(page).catch(() => {});
      await human.microScroll(page).catch(() => {});
      await human.randomDelay();

      if (i < groups.length - 1) {
        logger.info({ delayMs: config.loop.groupDelayMs, next: groups[i + 1].name }, "inter-group delay");
        await human.sleep(config.loop.groupDelayMs);
      }
    }

    try {
      await session.save(context);
    } catch (e) {
      logger.warn({ err: e.message }, "session save failed");
    }
  } finally {
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

  if (global.gc) try { global.gc(); } catch (_) {}

  const durationMin = Math.round((Date.now() - t0) / 60000);
  if (result.status === "completed") {
    const lines = result.posts
      .filter((p) => p.status === "success")
      .map((p) => `✅ ${p.group_name}${p.post_url ? ` — ${p.post_url}` : ""}`)
      .join("\n");
    await notify(`✅ Job terminé (${durationMin} min)\n${lines}`).catch(() => {});
  } else if (result.status === "partial") {
    const lines = result.posts
      .map((p) => p.status === "success"
        ? `✅ ${p.group_name}`
        : `❌ ${p.group_name} — ${p.error || "échec"}`)
      .join("\n");
    await notify(`⚠️ Job partiel (${durationMin} min)\n${lines}`).catch(() => {});
  } else if (result.status === "failed") {
    const lines = result.posts
      .map((p) => `❌ ${p.group_name} — ${p.error || "échec"}`)
      .join("\n");
    await notify(`🔴 Job échoué (${durationMin} min)\n${lines}`).catch(() => {});
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

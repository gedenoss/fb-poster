// src/modules/db.js
"use strict";
const { createClient } = require("@supabase/supabase-js");
const WebSocket = require("ws");
const config = require("../config");
const logger = require("../utils/logger");

const supabase = createClient(config.supabase.url, config.supabase.serviceKey, {
  auth: { persistSession: false },
  realtime: { transport: WebSocket },
});

// -----------------------------------------------------------------------
// Jobs
// -----------------------------------------------------------------------
async function claimNextJob() {
  const { data: row, error } = await supabase
    .from("fb_posting_jobs")
    .select("id, property_id")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!row) return null;

  const { data: updated, error: upErr } = await supabase
    .from("fb_posting_jobs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("status", "queued")
    .select("id, property_id")
    .maybeSingle();
  if (upErr) throw upErr;
  return updated;
}

async function claimJobById(jobId) {
  const { data, error } = await supabase
    .from("fb_posting_jobs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("status", "queued")
    .select("id, property_id")
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function markJobNeedsLogin(jobId, { error: errMsg } = {}) {
  await supabase
    .from("fb_posting_jobs")
    .update({ status: "needs_login", error: errMsg || null })
    .eq("id", jobId);
}

async function requeueJob(jobId) {
  await supabase
    .from("fb_posting_jobs")
    .update({ status: "queued", started_at: null, error: null })
    .eq("id", jobId);
}

async function completeJob(jobId, { status, result = null, error = null }) {
  const { error: e } = await supabase
    .from("fb_posting_jobs")
    .update({
      status,
      finished_at: new Date().toISOString(),
      result,
      error,
    })
    .eq("id", jobId);
  if (e) logger.error({ err: e, jobId }, "completeJob failed");
}

async function getStuckNeedsLoginJobs() {
  const { data, error } = await supabase
    .from("fb_posting_jobs")
    .select("id, property_id")
    .eq("status", "needs_login");
  if (error) throw error;
  return data || [];
}

// -----------------------------------------------------------------------
// Session state
// -----------------------------------------------------------------------
async function setSessionState(status, extra = {}) {
  const patch = {
    status,
    updated_at: new Date().toISOString(),
    ...(status === "ok" && {
      last_ok_at: new Date().toISOString(),
      last_error: null,
    }),
    ...(extra.lastError !== undefined && { last_error: extra.lastError }),
    ...(extra.checked && { last_check_at: new Date().toISOString() }),
  };
  await supabase.from("fb_session_state").update(patch).eq("id", 1);
}

async function getSessionState() {
  const { data } = await supabase
    .from("fb_session_state")
    .select("*")
    .eq("id", 1)
    .maybeSingle();
  return data;
}

// -----------------------------------------------------------------------
// Property payload
// -----------------------------------------------------------------------
async function fetchPropertyPayload(propertyId) {
  const { data: base, error } = await supabase
    .from("v_fb_property_payload")
    .select("*")
    .eq("property_id", propertyId)
    .maybeSingle();
  if (error) throw error;
  if (!base) throw new Error(`property ${propertyId} not found`);

  const images = [];
  if (base.cover_image) images.push(base.cover_image);

  // Best-effort: gather additional pictures from optional tables.
  try {
    const { data: vc } = await supabase
      .from("visual_content")
      .select("url")
      .eq("property_id", propertyId)
      .limit(10);
    if (Array.isArray(vc)) for (const r of vc) if (r.url) images.push(r.url);
  } catch (_) {
    /* table not present */
  }

  return {
    propertyId: base.property_id,
    title: base.title || "À louer",
    city: base.city || "",
    address: base.address || "",
    surface: base.surface_m2,
    bedrooms: base.bedrooms,
    description: base.description || "",
    priceFrom: base.price_from,
    images: Array.from(new Set(images)).slice(0, 10),
  };
}

// -----------------------------------------------------------------------
// Groups (with TEST_MODE filter)
// -----------------------------------------------------------------------
async function fetchActiveGroups({ city } = {}) {
  let q = supabase
    .from("fb_groups")
    .select("id, name, url, city, is_test")
    .eq("active", true);

  if (config.testMode) q = q.eq("is_test", true);

  if (city) q = q.or(`city.is.null,city.eq.${city}`);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// -----------------------------------------------------------------------
// Previous posts
// -----------------------------------------------------------------------
async function fetchPublishedPosts(propertyId) {
  const { data, error } = await supabase
    .from("fb_group_posts")
    .select("id, group_id, post_url")
    .eq("property_id", propertyId)
    .eq("status", "published");
  if (error) throw error;
  return data || [];
}

async function markPostDeleted(postId, { error: errMsg = null } = {}) {
  await supabase
    .from("fb_group_posts")
    .update({
      status: errMsg ? "failed" : "deleted",
      deleted_at: new Date().toISOString(),
      error: errMsg,
    })
    .eq("id", postId);
}

async function recordPublishedPost({ propertyId, groupId, jobId, postUrl }) {
  const { data, error } = await supabase
    .from("fb_group_posts")
    .insert({
      property_id: propertyId,
      group_id: groupId,
      job_id: jobId,
      post_url: postUrl,
      status: "published",
      published_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function recordFailedPost({ propertyId, groupId, jobId, error: errMsg }) {
  await supabase.from("fb_group_posts").insert({
    property_id: propertyId,
    group_id: groupId,
    job_id: jobId,
    status: "failed",
    error: (errMsg || "").slice(0, 1000),
  });
}

// -----------------------------------------------------------------------
// Action log
// -----------------------------------------------------------------------
async function log({
  jobId,
  groupId = null,
  level = "info",
  action,
  message = null,
  meta = null,
}) {
  try {
    await supabase.from("fb_action_logs").insert({
      job_id: jobId,
      group_id: groupId,
      level,
      action,
      message,
      meta,
    });
  } catch (e) {
    logger.warn({ err: e }, "log insert failed");
  }
}

module.exports = {
  supabase,
  claimNextJob,
  claimJobById,
  markJobNeedsLogin,
  requeueJob,
  completeJob,
  getStuckNeedsLoginJobs,
  setSessionState,
  getSessionState,
  fetchPropertyPayload,
  fetchActiveGroups,
  fetchPublishedPosts,
  markPostDeleted,
  recordPublishedPost,
  recordFailedPost,
  log,
};

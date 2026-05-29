//   POST /run-posting-job
//   GET  /run-posting-job/status?job_id=
//   GET  /run-posting-job/session
//
// env
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   WORKER_URL
//   WORKER_PUBLIC_URL
//   WORKER_SECRET

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WORKER_URL = Deno.env.get("WORKER_URL") ?? "";
const WORKER_PUBLIC_URL = Deno.env.get("WORKER_PUBLIC_URL") ?? "";
const WORKER_SECRET = Deno.env.get("WORKER_SECRET") ?? "";
const RELOGIN_TOKEN = Deno.env.get("RELOGIN_TOKEN") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function startOfCurrentWeek(): string {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString();
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

async function handleEnqueue(req: Request): Promise<Response> {
  let payload: { property_id?: string; requested_by?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid_json" });
  }

  const propertyId = payload.property_id?.trim();
  const requestedBy = payload.requested_by?.trim() || null;

  if (!propertyId || !UUID_RE.test(propertyId)) {
    return json({ error: "invalid_property_id" });
  }

  const { data: prop, error: propErr } = await supabase
    .from("property")
    .select("id, available_room_for_sales")
    .eq("id", propertyId)
    .maybeSingle();
  if (propErr) return json({ error: "db_error", detail: propErr.message });
  if (!prop) return json({ error: "property_not_found" });
  if (!(prop.available_room_for_sales > 0)) {
    return json({ error: "no_available_rooms", message: "pas de room dispo dans cette property" });
  }

  const weekStart = startOfCurrentWeek();
  const { data: weeklyJob } = await supabase
    .from("fb_posting_jobs")
    .select("id, created_at")
    .in("status", ["queued", "running", "completed", "partial"])
    .gte("created_at", weekStart)
    .limit(1)
    .maybeSingle();
  if (weeklyJob) {
    const nextMonday = new Date();
    nextMonday.setDate(nextMonday.getDate() + (8 - (nextMonday.getDay() || 7)));
    nextMonday.setHours(0, 0, 0, 0);
    return json({
      error: "weekly_limit_reached",
      message: `bot déjà été utilisé cette semaine, prochain envoi possible le ${nextMonday.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })} :)`,
      job_id: weeklyJob.id,
      next_allowed_at: nextMonday.toISOString(),
    });
  }

  const { data: existing } = await supabase
    .from("fb_posting_jobs")
    .select("id, status")
    .eq("property_id", propertyId)
    .in("status", ["queued", "running", "needs_login"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) {
    const extras = await maybeReloginPayload(existing.status);
    return json({ status: existing.status, job_id: existing.id, deduped: true, ...extras });
  }

  const { data: job, error: insErr } = await supabase
    .from("fb_posting_jobs")
    .insert({ property_id: propertyId, requested_by: requestedBy, status: "queued" })
    .select("id")
    .single();
  if (insErr || !job)
    return json({ error: "enqueue_failed", detail: insErr?.message });

  if (WORKER_URL) {
    fetch(WORKER_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-key": WORKER_SECRET },
      body: JSON.stringify({ job_id: job.id }),
    }).catch(() => {});
  }

  return json({ status: "queued", job_id: job.id });
}

async function handleStatus(url: URL): Promise<Response> {
  const jobId = url.searchParams.get("job_id");
  if (!jobId || !UUID_RE.test(jobId)) return json({ error: "invalid_job_id" });

  const { data, error } = await supabase
    .from("fb_posting_jobs")
    .select("id, status, error, result, created_at, started_at, finished_at")
    .eq("id", jobId)
    .maybeSingle();
  if (error) return json({ error: "db_error", detail: error.message });
  if (!data) return json({ error: "not_found" });

  const extras = await maybeReloginPayload(data.status);
  return json({ ...data, ...extras });
}

async function handleSession(): Promise<Response> {
  const { data, error } = await supabase
    .from("fb_session_state")
    .select("status, last_check_at, last_ok_at, last_error, updated_at")
    .eq("id", 1)
    .maybeSingle();
  if (error) return json({ error: "db_error", detail: error.message });
  const extras = await maybeReloginPayload(data?.status ?? "unknown");
  return json({ ...data, ...extras });
}

async function maybeReloginPayload(status: string | null | undefined) {
  if (status !== "needs_login") return {};
  let url = WORKER_PUBLIC_URL ? `${WORKER_PUBLIC_URL}/relogin` : null;
  if (url && RELOGIN_TOKEN) url = `${url}?token=${encodeURIComponent(RELOGIN_TOKEN)}`;
  return { relogin_url: url };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (req.method === "POST" && (path.endsWith("/run-posting-job") || path === "")) {
    return handleEnqueue(req);
  }
  if (req.method === "GET" && path.endsWith("/status")) {
    return handleStatus(url);
  }
  if (req.method === "GET" && path.endsWith("/session")) {
    return handleSession();
  }
  return json({ error: "not_found" });
});

// supabase/functions/run-posting-job/index.ts
// ---------------------------------------------------------------------------
// Multi-route Edge Function for the FB poster.
//
//   POST /run-posting-job         { property_id }     → enqueue a job
//   GET  /run-posting-job/status?job_id=...           → poll a job
//   GET  /run-posting-job/session                     → session health (ok / needs_login)
//
// Env required:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   WORKER_URL          (e.g. https://fb-worker.onrender.com/trigger)
//   WORKER_PUBLIC_URL   (e.g. https://fb-worker.onrender.com)
//                         — returned to the frontend so it can open /relogin
//   WORKER_SECRET       (shared with worker for HTTP triggers)
// ---------------------------------------------------------------------------

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WORKER_URL = Deno.env.get("WORKER_URL") ?? "";
const WORKER_PUBLIC_URL = Deno.env.get("WORKER_PUBLIC_URL") ?? "";
const WORKER_SECRET = Deno.env.get("WORKER_SECRET") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleEnqueue(req: Request): Promise<Response> {
  let payload: { property_id?: string; requested_by?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const propertyId = payload.property_id?.trim();
  const requestedBy = payload.requested_by?.trim() || null;

  if (!propertyId || !UUID_RE.test(propertyId)) {
    return json({ error: "invalid_property_id" }, 400);
  }

  // 1. Property must exist.
  const { data: prop, error: propErr } = await supabase
    .from("property")
    .select("id")
    .eq("id", propertyId)
    .maybeSingle();
  if (propErr) return json({ error: "db_error", detail: propErr.message }, 500);
  if (!prop) return json({ error: "property_not_found" }, 404);

  // 2. De-dupe: if there's already an in-flight job for this property, return it.
  const { data: existing } = await supabase
    .from("fb_posting_jobs")
    .select("id, status")
    .eq("property_id", propertyId)
    .in("status", ["queued", "running", "needs_login"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) {
    const { data: session } = await supabase
      .from("fb_session_state")
      .select("status")
      .eq("id", 1)
      .maybeSingle();
    const sessionStatus = session?.status ?? "unknown";
    // Return job status, but also check session status for relogin hint
    const jobExtras = await maybeReloginPayload(existing.status);
    const sessionExtras =
      sessionStatus === "needs_login"
        ? await maybeReloginPayload("needs_login")
        : {};
    return json({
      status: existing.status,
      job_id: existing.id,
      deduped: true,
      ...jobExtras,
      ...sessionExtras,
    });
  }

  // 3. Enqueue.
  const { data: job, error: insErr } = await supabase
    .from("fb_posting_jobs")
    .insert({
      property_id: propertyId,
      requested_by: requestedBy,
      status: "queued",
    })
    .select("id")
    .single();
  if (insErr || !job)
    return json({ error: "enqueue_failed", detail: insErr?.message }, 500);

  // 4. Best-effort: ping the worker.
  if (WORKER_URL) {
    fetch(WORKER_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-worker-key": WORKER_SECRET,
      },
      body: JSON.stringify({ job_id: job.id }),
    }).catch(() => {});
  }

  // 5. Check session status and include relogin_url if needed.
  const { data: session } = await supabase
    .from("fb_session_state")
    .select("status")
    .eq("id", 1)
    .maybeSingle();
  const sessionStatus = session?.status ?? "unknown";
  const extras = await maybeReloginPayload(sessionStatus);

  return json({ status: "queued", job_id: job.id, ...extras });
}

async function handleStatus(url: URL): Promise<Response> {
  const jobId = url.searchParams.get("job_id");
  if (!jobId || !UUID_RE.test(jobId))
    return json({ error: "invalid_job_id" }, 400);

  const { data, error } = await supabase
    .from("fb_posting_jobs")
    .select("id, status, error, result, created_at, started_at, finished_at")
    .eq("id", jobId)
    .maybeSingle();
  if (error) return json({ error: "db_error", detail: error.message }, 500);
  if (!data) return json({ error: "not_found" }, 404);

  const extras = await maybeReloginPayload(data.status);
  return json({ ...data, ...extras });
}

async function handleSession(): Promise<Response> {
  const { data, error } = await supabase
    .from("fb_session_state")
    .select("status, last_check_at, last_ok_at, last_error, updated_at")
    .eq("id", 1)
    .maybeSingle();
  if (error) return json({ error: "db_error", detail: error.message }, 500);
  const extras = await maybeReloginPayload(data?.status ?? "unknown");
  return json({ ...data, ...extras });
}

async function maybeReloginPayload(status: string | null | undefined) {
  if (status !== "needs_login") return {};
  return {
    relogin_url: WORKER_PUBLIC_URL ? `${WORKER_PUBLIC_URL}/relogin` : null,
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");

  // Path layout supports both Supabase function paths and direct.
  // Supabase will route any subpath under /run-posting-job to this function.
  if (
    req.method === "POST" &&
    (path.endsWith("/run-posting-job") || path === "")
  ) {
    return handleEnqueue(req);
  }
  if (req.method === "GET" && path.endsWith("/status")) {
    return handleStatus(url);
  }
  if (req.method === "GET" && path.endsWith("/session")) {
    return handleSession();
  }
  return json({ error: "not_found" }, 404);
});

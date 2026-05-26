// src/index.js
"use strict";
const path = require("path");
const express = require("express");
const config = require("./config");
const logger = require("./utils/logger");
const db = require("./modules/db");
const { runJob, reloginLink } = require("./modules/orchestrator");
const relogin = require("./modules/relogin");

// === DEBUG PLAYWRIGHT INSTALL ===
const { execSync } = require("child_process");
try {
  console.log("[debug] process.cwd() =", process.cwd());
  console.log("[debug] __dirname =", __dirname);
  console.log(
    "[debug] PLAYWRIGHT_BROWSERS_PATH =",
    process.env.PLAYWRIGHT_BROWSERS_PATH || "(unset)",
  );
  console.log("[debug] HOME =", process.env.HOME || "(unset)");

  console.log("[debug] ls cwd:");
  console.log(execSync("ls -la 2>&1").toString());

  console.log("[debug] ls node_modules/playwright (looking for browsers):");
  console.log(
    execSync(
      'ls -la node_modules/playwright/.local-browsers 2>&1 || echo "MISSING"',
    ).toString(),
  );

  console.log("[debug] find playwright cache anywhere on disk:");
  console.log(
    execSync(
      'find / -name "chrome-headless-shell" -type f 2>/dev/null | head -5 || echo "NONE"',
    ).toString(),
  );

  console.log(
    "[debug] playwright version:",
    execSync("npx playwright --version 2>&1").toString().trim(),
  );

  // Where does playwright THINK its browsers are?
  console.log("[debug] playwright registry expected paths:");
  console.log(
    execSync(
      "node -e \"const r=require('playwright-core/lib/server/registry'); const reg=new r.Registry(require('playwright-core/browsers.json')); console.log(JSON.stringify(reg.executablesForChannel ? 'has reg' : 'no reg'));\" 2>&1 || echo \"introspection failed\"",
    ).toString(),
  );
} catch (e) {
  console.error("[debug] failed:", e.message);
}
// === FIN DEBUG ===

// =============================================================================
// Single in-flight lock — one job at a time per worker
// =============================================================================
let busy = false;

async function tryProcessNext({ jobId } = {}) {
  if (busy) return { skipped: true, reason: "busy" };

  // Don't pick up jobs if the session is known to be dead.
  const ss = await db.getSessionState();
  if (ss && ss.status === "needs_login") {
    return { skipped: true, reason: "session_needs_login" };
  }

  busy = true;
  try {
    const job = jobId ? await db.claimJobById(jobId) : await db.claimNextJob();
    if (!job) return { skipped: true, reason: "no_job" };

    let outcome;
    try {
      outcome = await runJob(job);
      if (outcome && outcome.needsLogin) {
        await db.markJobNeedsLogin(job.id, { error: "session_invalid" });
        return { needsLogin: true, job_id: job.id };
      }
      await db.completeJob(job.id, { status: outcome.status, result: outcome });
    } catch (err) {
      logger.error(
        { err: err.message, stack: err.stack, jobId: job.id },
        "job crashed",
      );
      await db.completeJob(job.id, {
        status: "failed",
        error: err.message,
        result: { posts: [] },
      });
      outcome = { status: "failed", posts: [], error: err.message };
    }
    return { processed: true, job_id: job.id, ...outcome };
  } finally {
    busy = false;
  }
}

// =============================================================================
// HTTP server
// =============================================================================
const app = express();
app.use(express.json({ limit: "1mb" }));

// --- Middleware -------------------------------------------------------------
function workerAuth(req, res, next) {
  if (!config.http.secret) return next();
  if (req.get("x-worker-key") !== config.http.secret) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

function reloginAuth(req, res, next) {
  if (!config.http.reloginToken) return next();
  const token = req.query.token || req.get("x-relogin-token");
  if (token !== config.http.reloginToken) {
    return res
      .status(401)
      .json({ error: "unauthorized", reason: "unauthorized" });
  }
  next();
}

// --- Health -----------------------------------------------------------------
// APRÈS (réponse instantanée même quand Chromium tourne) :
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, busy });
});

// --- Trigger (called by the Edge Function) ----------------------------------
app.post("/trigger", workerAuth, async (req, res) => {
  const jobId = (req.body && req.body.job_id) || null;
  res.json({ status: "accepted", job_id: jobId });
  setImmediate(async () => {
    try {
      const r = await tryProcessNext({ jobId });
      logger.info({ r }, "trigger result");
    } catch (e) {
      logger.error({ err: e.message }, "trigger failed");
    }
  });
});

// --- Re-login (Phase 1: email + password) -----------------------------------
app.get("/relogin", reloginAuth, (_req, res) => {
  res.sendFile(path.resolve(__dirname, "public/relogin.html"));
});

app.post("/api/relogin/start", reloginAuth, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ ok: false, reason: "missing_fields" });
  }
  const r = await relogin.startLogin({ email, password });
  res.json(r);
});

// --- Re-login (Phase 2: 2FA code) -------------------------------------------
app.post("/api/relogin/2fa", reloginAuth, async (req, res) => {
  const { pendingToken, code } = req.body || {};
  if (!pendingToken || !code) {
    return res.status(400).json({ ok: false, reason: "missing_fields" });
  }
  const r = await relogin.submitTwoFactor({ pendingToken, code });
  res.json(r);
});

// =============================================================================
// Polling loop
// =============================================================================
async function pollLoop() {
  while (true) {
    try {
      const r = await tryProcessNext();
      if (r && r.processed) continue;
    } catch (e) {
      logger.error({ err: e.message }, "poll iteration failed");
    }
    await new Promise((r) => setTimeout(r, config.loop.pollIntervalMs));
  }
}

// =============================================================================
// Boot
// =============================================================================
app.listen(config.http.port, () => {
  logger.info(
    {
      port: config.http.port,
      testMode: config.testMode,
      publicUrl: config.http.publicBaseUrl || "(unset)",
      reloginUrl: reloginLink() || "(no PUBLIC_BASE_URL set)",
    },
    "worker http listening",
  );
});

pollLoop().catch((e) => {
  logger.error({ err: e.message }, "poll loop died");
  process.exit(1);
});

function shutdown(sig) {
  logger.info({ sig }, "shutting down");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

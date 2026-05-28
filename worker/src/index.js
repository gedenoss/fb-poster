"use strict";
const path = require("path");
const express = require("express");
const config = require("./config");
const logger = require("./utils/logger");
const db = require("./modules/db");
const { runJob, reloginLink } = require("./modules/orchestrator");
const relogin = require("./modules/relogin");

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

const app = express();
app.use(express.json({ limit: "1mb" }));

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

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, busy });
});

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

app.post("/api/relogin/2fa", reloginAuth, async (req, res) => {
  const { pendingToken, code } = req.body || {};
  if (!pendingToken || !code) {
    return res.status(400).json({ ok: false, reason: "missing_fields" });
  }
  const r = await relogin.submitTwoFactor({ pendingToken, code });
  res.json(r);
});

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
  logger.info({ sig, busy }, "shutting down");
  if (!busy) return process.exit(0);
  const deadline = setTimeout(() => process.exit(0), 30_000);
  deadline.unref();
  const poll = setInterval(() => {
    if (!busy) { clearInterval(poll); process.exit(0); }
  }, 500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

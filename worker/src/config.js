"use strict";
require("dotenv").config();
const path = require("path");

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function int(name, def) {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be an integer`);
  return n;
}

function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return /^(1|true|yes)$/i.test(v);
}

const config = {
  supabase: {
    url: required("SUPABASE_URL"),
    serviceKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  },
  http: {
    port: int("PORT", 8080),
    secret: process.env.WORKER_SECRET || "",
    publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
    reloginToken: process.env.RELOGIN_TOKEN || "",
  },
  session: {
    localPath: path.resolve(
      process.cwd(),
      process.env.SESSION_LOCAL_PATH || "./data/state.json",
    ),
    bucket: process.env.SESSION_BUCKET || "",
    objectKey: process.env.SESSION_OBJECT_KEY || "state.json",
  },
  browser: {
    headless: bool("HEADLESS", true),
    locale: process.env.BROWSER_LOCALE || "fr-FR",
    userAgent: process.env.USER_AGENT || "",
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || "",
  },
  loop: {
    pollIntervalMs: int("POLL_INTERVAL_MS", 10000),
    groupDelayMs: int("GROUP_DELAY_MS", 480_000),
    maxGroupsPerJob: int("MAX_GROUPS_PER_JOB", 10),
    browserRecycleEvery: int("BROWSER_RECYCLE_EVERY", 5),
  },
  human: {
    typingMinMs: int("TYPING_MIN_MS", 20),
    typingMaxMs: int("TYPING_MAX_MS", 80),
    actionDelayMinMs: int("ACTION_DELAY_MIN_MS", 5000),
    actionDelayMaxMs: int("ACTION_DELAY_MAX_MS", 15000),
  },
  paths: {
    tmpImageDir: path.resolve(
      process.cwd(),
      process.env.TMP_IMAGE_DIR || "./data/images",
    ),
  },
  testMode: bool("TEST_MODE", false),
  notifications: {
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || "",
  },
};

module.exports = config;

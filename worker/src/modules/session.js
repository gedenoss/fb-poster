"use strict";
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const config = require("../config");
const logger = require("../utils/logger");
const { supabase } = require("./db");

async function ensureDir(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

async function pullRemoteSession() {
  if (!config.session.bucket) return false;
  const { data, error } = await supabase.storage
    .from(config.session.bucket)
    .download(config.session.objectKey);
  if (error) {
    logger.info(
      { err: error.message },
      "No remote session yet (fine on first run)",
    );
    return false;
  }
  await ensureDir(config.session.localPath);
  const buf = Buffer.from(await data.arrayBuffer());
  await fsp.writeFile(config.session.localPath, buf);
  logger.info("Pulled remote session into state.json");
  return true;
}

async function pushRemoteSession() {
  if (!config.session.bucket) return false;
  if (!fs.existsSync(config.session.localPath)) return false;
  const buf = await fsp.readFile(config.session.localPath);
  const { error } = await supabase.storage
    .from(config.session.bucket)
    .upload(config.session.objectKey, buf, {
      upsert: true,
      contentType: "application/json",
    });
  if (error) {
    logger.warn({ err: error.message }, "Session upload failed");
    return false;
  }
  logger.info("Pushed session to remote storage");
  return true;
}

function hasLocalSession() {
  return fs.existsSync(config.session.localPath);
}
function localPath() {
  return config.session.localPath;
}

async function save(context) {
  await ensureDir(config.session.localPath);
  await context.storageState({ path: config.session.localPath });
  await pushRemoteSession();
}

async function clear() {
  try {
    if (fs.existsSync(config.session.localPath))
      await fsp.unlink(config.session.localPath);
  } catch (_) {}
  if (config.session.bucket) {
    try {
      await supabase.storage
        .from(config.session.bucket)
        .remove([config.session.objectKey]);
    } catch (e) {
      logger.warn({ err: e.message }, "Remote session delete failed");
    }
  }
}

module.exports = {
  pullRemoteSession,
  pushRemoteSession,
  hasLocalSession,
  localPath,
  save,
  clear,
};

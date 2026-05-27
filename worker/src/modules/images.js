// src/modules/images.js
"use strict";
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const config = require("../config");
const logger = require("../utils/logger");
const { supabase } = require("./db");

async function ensureTmpDir() {
  await fsp.mkdir(config.paths.tmpImageDir, { recursive: true });
  return config.paths.tmpImageDir;
}

function hashName(url) {
  const h = crypto.createHash("sha1").update(url).digest("hex").slice(0, 16);
  let ext = path.extname(url.split("?")[0]).toLowerCase();
  if (!/^\.(jpg|jpeg|png|webp|gif)$/.test(ext)) ext = ".jpg";
  return `${h}${ext}`;
}

async function downloadOne(url) {
  if (!url) throw new Error("empty url");
  const dir = await ensureTmpDir();
  const dest = path.join(dir, hashName(url));

  if (fs.existsSync(dest) && (await fsp.stat(dest)).size > 0) return dest;

  if (/^https?:\/\//i.test(url)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
    const buf = await res.arrayBuffer();
    await fsp.writeFile(dest, Buffer.from(buf));
    buf = null; // Explicit release
    return dest;
  }

  const [bucket, ...rest] = url.split("/");
  const key = rest.join("/");
  if (!bucket || !key) throw new Error(`Cannot parse storage path: ${url}`);

  const { data, error } = await supabase.storage.from(bucket).download(key);
  if (error)
    throw new Error(`storage download failed for ${url}: ${error.message}`);
  const buf = await data.arrayBuffer();
  await fsp.writeFile(dest, Buffer.from(buf));
  buf = null; // Explicit release
  return dest;
}

async function downloadMany(urls) {
  const out = [];
  for (const u of urls) {
    try {
      out.push(await downloadOne(u));
    } catch (e) {
      logger.warn({ url: u, err: e.message }, "image download failed");
    }
  }
  return out;
}

async function cleanup() {
  try {
    const dir = config.paths.tmpImageDir;
    if (!fs.existsSync(dir)) return;
    for (const f of await fsp.readdir(dir)) {
      await fsp.rm(path.join(dir, f), { force: true });
    }
    logger.debug({ dir }, "image cache cleared");
  } catch (e) {
    logger.warn({ err: e.message }, "image cleanup failed");
  }
}

module.exports = { downloadOne, downloadMany, cleanup };

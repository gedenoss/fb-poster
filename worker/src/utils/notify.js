"use strict";
const config = require("../config");
const logger = require("./logger");

async function notify(text, { linkText, linkUrl } = {}) {
  const url = config.notifications.discordWebhookUrl;
  if (!url) return;

  const content = linkUrl
    ? `${text}\n\n[${linkText || "Ouvrir"}](${linkUrl})`
    : text;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
  } catch (e) {
    logger.warn({ err: e.message }, "discord notify failed");
  }
}

module.exports = { notify };

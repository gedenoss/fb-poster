// src/utils/notify.js
'use strict';
const config = require('../config');
const logger = require('./logger');

/**
 * Best-effort Slack webhook ping. Never throws.
 * Pass `text` and optionally `link_text` + `link_url`.
 */
async function slack(text, { linkText, linkUrl } = {}) {
  const url = config.notifications.slackWebhookUrl;
  if (!url) return;

  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text } },
  ];
  if (linkUrl) {
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: linkText || 'Open' },
        url: linkUrl,
      }],
    });
  }

  try {
    await fetch(url, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ text, blocks }),
    });
  } catch (e) {
    logger.warn({ err: e.message }, 'slack notify failed');
  }
}

module.exports = { slack };

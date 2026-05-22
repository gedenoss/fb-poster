// src/modules/content.js
"use strict";

function formatPrice(value) {
  if (value === null || value === undefined) return "";
  const n = Number(value);
  if (Number.isNaN(n) || n <= 0) return "";
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(n);
}

function stripHtml(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

/**
 * Spec format:
 *   Title
 *
 *   Price
 *   City
 *
 *   Description
 */
function buildPostText(payload) {
  return "test";
  /*
  const lines = [];

  if (payload.title) lines.push(payload.title.trim());
  lines.push("");

  const priceLine = formatPrice(payload.priceFrom);
  if (priceLine) lines.push(`À partir de ${priceLine} / mois`);
  if (payload.city) lines.push(payload.city.trim());

  const meta = [];
  if (payload.surface) meta.push(`${payload.surface} m²`);
  if (payload.bedrooms)
    meta.push(`${payload.bedrooms} chambre${payload.bedrooms > 1 ? "s" : ""}`);
  if (meta.length) {
    lines.push("");
    lines.push(meta.join(" · "));
  }

  if (payload.description) {
    lines.push("");
    lines.push(stripHtml(payload.description).trim());
  }

  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  */
}

module.exports = { buildPostText, formatPrice };

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

function roomLabel(n) {
  if (!n || n <= 0) return null;
  return `${n} chambre${n > 1 ? "s" : ""}`;
}

function buildPostText(payload) {
  const price = formatPrice(payload.priceFrom);
  const desc = payload.description ? stripHtml(payload.description).trim() : "";
  const city = (payload.city || "").trim();
  const title = (payload.title || "").trim();
  const surface = payload.surface ? `${payload.surface} m²` : null;
  const rooms = roomLabel(payload.bedrooms);
  const available = payload.availableRooms > 0 ? payload.availableRooms : null;

  const variant = Math.floor(Math.random() * 3);

  if (variant === 0) {
    const lines = [title];
    lines.push("");
    if (desc) lines.push(desc, "");
    const specs = [surface, rooms].filter(Boolean).join(" · ");
    if (specs) lines.push(specs);
    if (price) lines.push(`À partir de ${price} / mois`);
    if (city) lines.push(city);
    if (available) lines.push(`\n${available} chambre${available > 1 ? "s" : ""} disponible${available > 1 ? "s" : ""} dès maintenant`);
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  if (variant === 1) {
    const lines = [];
    if (available) lines.push(`${available} chambre${available > 1 ? "s" : ""} disponible${available > 1 ? "s" : ""} à ${city || "louer"}`, "");
    lines.push(title, "");
    if (desc) lines.push(desc, "");
    const specs = [surface, price ? `dès ${price} / mois` : null].filter(Boolean).join(" | ");
    if (specs) lines.push(specs);
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // variant 2
  const lines = [];
  const header = [title, city].filter(Boolean).join(" — ");
  lines.push(header, "");
  if (desc) lines.push(desc, "");
  const specs = [surface, rooms, available ? `${available} disponible${available > 1 ? "s" : ""}` : null].filter(Boolean).join(" · ");
  if (specs) lines.push(specs);
  if (price) lines.push(`À partir de ${price} / mois`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = { buildPostText, formatPrice };

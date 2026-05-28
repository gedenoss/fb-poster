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

function buildPostText(payload) {
  const price = formatPrice(payload.priceFrom);
  const city = (payload.city || "").trim();
  const title = (payload.title || "").trim();
  const surface = payload.surface ? `${payload.surface}m²` : null;
  const totalRooms = payload.bedrooms || null;
  const available = payload.availableRooms > 0 ? payload.availableRooms : null;

  const variant = Math.floor(Math.random() * 3);

  if (variant === 0) {
    const lines = ["Bonjour !", ""];
    if (available) {
      const ch = available > 1 ? "chambres disponibles" : "chambre disponible";
      lines.push(`Il reste ${available} ${ch} au sein de notre immeuble${city ? ` à ${city}` : ""}.`);
    }
    lines.push("");
    const specs = [title, surface, totalRooms ? `${totalRooms} chambre${totalRooms > 1 ? "s" : ""} au total` : null].filter(Boolean).join(" — ");
    if (specs) lines.push(specs);
    if (price) lines.push(`Loyer à partir de ${price} / mois.`);
    lines.push("", "N'hésitez pas à nous contacter par message pour plus d'informations !");
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  if (variant === 1) {
    const lines = ["Bonjour à tous !", ""];
    if (available && city) {
      const ch = available > 1 ? "chambres à louer" : "chambre à louer";
      lines.push(`Nous proposons ${available} ${ch} à ${city}.`);
    }
    lines.push("");
    if (title) lines.push(title);
    const specs = [surface, totalRooms ? `${totalRooms} chambre${totalRooms > 1 ? "s" : ""} au total` : null].filter(Boolean).join(", ");
    if (specs) lines.push(specs);
    if (price) lines.push(`À partir de ${price} / mois.`);
    lines.push("", "Contactez-nous en message privé pour organiser une visite !");
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // variant 2
  const lines = [];
  if (available) {
    const ch = available > 1 ? "chambres disponibles" : "chambre disponible";
    lines.push(`${available} ${ch}${city ? ` à ${city}` : ""} !`, "");
  }
  if (title) lines.push(title);
  const specs = [surface, totalRooms ? `${totalRooms} chambre${totalRooms > 1 ? "s" : ""}` : null].filter(Boolean).join(" — ");
  if (specs) lines.push(specs);
  if (price) lines.push(`Loyer : à partir de ${price} / mois.`);
  lines.push("", "Pour plus d'infos, envoyez-nous un message !");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = { buildPostText };

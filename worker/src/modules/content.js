"use strict";

function buildPostText(payload) {
  const city = (payload.city || "").trim();
  const surface = payload.surface || null;
  const bedrooms = payload.bedrooms || null;
  const bathrooms = payload.bathrooms || null;
  const toilets = payload.toilets || null;
  const balconies = payload.balconies || 0;
  const price = payload.priceFrom ? Math.round(payload.priceFrom) : null;
  const lines = payload.nearestStationLines || null;

  // ── French ──────────────────────────────────────────────────────────────
  const fr = [];

  fr.push(`Toujours à la recherche d'un(e) coloc pour rejoindre notre colocation${city ? ` à ${city}` : ""}.`);
  fr.push("");

  if (lines) {
    fr.push(`Il est situé au pied du métro ligne ${lines}.`);
    fr.push("");
  }

  const frEquip = [];
  if (balconies > 0) frEquip.push(`${balconies} balcon${balconies > 1 ? "s" : ""}`);
  if (toilets) frEquip.push(`${toilets} WC`);
  if (bathrooms) frEquip.push(`${bathrooms} salle${bathrooms > 1 ? "s" : ""} de bains`);
  fr.push(`L'appartement est complètement meublé et équipé${frEquip.length ? `, ${frEquip.join(", ")}` : ""}.`);
  fr.push("");

  if (bedrooms || surface) {
    const sizeStr = bedrooms ? `C'est une coloc de ${bedrooms} chambre${bedrooms > 1 ? "s" : ""}` : "C'est une colocation";
    fr.push(`${sizeStr}${surface ? ` de ${surface}m²` : ""}.`);
    fr.push("");
  }

  if (price) {
    fr.push(`Niveau loyer, il faut compter entre ${price} euros par mois avec Internet, électricité, chauffage, assurance, etc.`);
    fr.push("");
  }

  fr.push("N'hésitez pas à me contacter en MP si vous souhaitez plus d'informations ou si vous souhaitez venir visiter.");
  fr.push("");
  fr.push("À très vite !");

  // ── English ─────────────────────────────────────────────────────────────
  const en = [];

  en.push("--");
  en.push("");
  en.push("Hello!");
  en.push("");
  en.push(`We're still looking for a flatmate to join our shared apartment${city ? ` in ${city}` : ""}.`);
  en.push("");

  if (lines) {
    en.push(`It's located right next to metro line ${lines}.`);
    en.push("");
  }

  const enEquip = [];
  if (balconies > 0) en.push(`with ${balconies} outdoor balcon${balconies > 1 ? "ies" : "y"}`);
  if (toilets) enEquip.push(`${toilets} toilet${toilets > 1 ? "s" : ""}`);
  if (bathrooms) enEquip.push(`${bathrooms} shared bathroom${bathrooms > 1 ? "s" : ""}`);
  const enEquipFull = [balconies > 0 ? `${balconies} outdoor balcon${balconies > 1 ? "ies" : "y"}` : null, ...enEquip].filter(Boolean);
  en.push(`The flat is fully furnished${enEquipFull.length ? `, with ${enEquipFull.join(", ")}` : ""}.`);
  en.push("");

  if (bedrooms || surface) {
    const enSize = bedrooms ? `The flat is a ${bedrooms}-room flat sharing` : "The flat is a shared apartment";
    en.push(`${enSize}${surface ? ` of ${surface}sqm` : ""}.`);
    en.push("");
  }

  if (price) {
    en.push(`The rent is ${price} euros per month, including internet, electricity, heating, insurance, etc.`);
    en.push("");
  }

  en.push("Feel free to message me if you'd like more information or if you'd like to come visit.");
  en.push("");
  en.push("See you soon!");

  return [...fr, ...en].join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = { buildPostText };

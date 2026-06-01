const fs = require("fs");
const path = require("path");

const INPUT = process.argv[2] || "./cookies-export.json";
const OUTPUT = process.argv[3] || "./state.json";

if (!fs.existsSync(INPUT)) {
  console.error(`Input file not found: ${INPUT}`);
  console.error("Usage: node convert-cookies.js [input.json] [output.json]");
  process.exit(1);
}

const raw = fs.readFileSync(INPUT, "utf8");
const cookieList = JSON.parse(raw);

if (!Array.isArray(cookieList)) {
  console.error("Expected an array of cookies in the input file.");
  process.exit(1);
}

const cookies = cookieList.map((c) => {
  const out = {
    name: c.name,
    value: c.value,
    domain: c.domain.startsWith(".") ? c.domain : "." + c.domain,
    path: c.path || "/",
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: "Lax",
  };

  if (c.sameSite) {
    const s = c.sameSite.toLowerCase();
    if (s === "no_restriction" || s === "none") out.sameSite = "None";
    else if (s === "lax") out.sameSite = "Lax";
    else if (s === "strict") out.sameSite = "Strict";
  }

  if (typeof c.expirationDate === "number") {
    out.expires = Math.floor(c.expirationDate);
  } else if (c.session) {
    out.expires = -1;
  } else {
    out.expires = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
  }

  return out;
});

const storageState = {
  cookies,
  origins: [],
};

fs.writeFileSync(OUTPUT, JSON.stringify(storageState, null, 2));
console.log(`✓ Wrote ${cookies.length} cookies to ${OUTPUT}`);
console.log("");
console.log("Next steps:");
console.log("  1. Upload state.json to Supabase Storage:");
console.log("     - Bucket: fb-sessions");
console.log("     - File path: state.json");
console.log(
  "  2. In Supabase SQL: UPDATE fb_session_state SET status='ok', last_ok_at=now(), last_error=null WHERE id=1;",
);
console.log(
  "  3. Trigger your job — the worker will pull this session from the bucket.",
);

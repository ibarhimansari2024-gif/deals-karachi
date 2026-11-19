#!/usr/bin/env node
/**
 * Karachi Pulse — real deal ingestion (Node.js backend, GitHub Actions har 10 min).
 *
 * Sources (all public, keyless, ToS-respecting):
 *   1. YouTube /videos pages of configured Karachi channels (ytInitialData parse)
 *   2. data/curated.json — hand-captured deals (verified base)
 *   3. brandtijara.com — fashion brand sales
 *   4. 20 Shopify catalogs — live sale products with real prices + photos
 *
 * Output: data/deals.json (the live feed the app fetches every refresh).
 * Port of ingest.py — same output schema (version 3), same cache files.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const DEALS = path.join(DATA, "deals.json");
const CURATED = path.join(DATA, "curated.json");
const CHANNELS_FILE = path.join(DATA, "channels.txt");
const UA = "Mozilla/5.0 (compatible; KarachiPulse/2.0)";

// videos must mention a deal-ish keyword to become an app deal
const DEAL_WORDS = /\b(deal|deals|offer|sale|buffet|platter|free|discount|combo|price|rs\.?)\b/i;
// food context filter — market/crockery/gadget videos ko rokta hai
const FOOD_WORDS = /food|biryani|pizza|burger|buffet|karahi|bbq|platter|roll|kabab|kebab|dessert|ice\s?cream|chai|nihari|broast|fries|shawarma|manda|mandi|pulao|chat|chaat|sweets|bakery|iftar|drink|juice|fried|grill|steak|sandwich|wrap|paratha|chicken|mutton|beef|fish/i;
// fashion/clothing/shopping keywords
const FASHION_WORDS = /kurti|kurta|lawn|unstitched|pret|suit|suits|kapray|kapre|clothes|clothing|shoes|sandal|sneaker|jeans|shirt|frock|hoodie|sweatshirt|bag|purse|makeup|cosmetic|perfume|jewellery|jewelry|watch|sale|bazaar|market|mall|outlet|brand|wear|fashion|crocery|grocery|crockery|gadget|mobile|phone|shopping|kitchen/i;
const PRICE_RE = /rs\.?\s*([\d,]{3,6})/gi;
const AREA_WORDS = ["DHA", "Clifton", "Gulshan", "Nazimabad", "Bahadurabad", "Saddar",
  "Malir", "Samanabad", "Federal B", "North Nazimabad", "Karachi"];

function classify(text) {
  if (FOOD_WORDS.test(text)) return "Food";
  if (FASHION_WORDS.test(text)) return "Fashion";
  return "Shopping";
}

const BT_URL = "https://www.brandtijara.com/in-store/karachi";

// brand -> domain: deal title se brand pehchan kar us ki picture lagate hain
const BRAND_SITES = {
  "domino": "dominos.pk",
  "kababjees": "kababjees.com",
  "btb": "btbmore.com",
  "khaadi": "khaadi.com",
  "gul ahmed": "gulahmedshop.com",
  "limelight": "limelight.pk",
  "outfitters": "outfitters.com.pk",
  "bata": "bata.com.pk",
  "hashim food": "hashimfood.com",
  // fashion/shoes brands (user demand: brand ki apni REAL product photo)
  "hush puppies": "hushpuppies.com.pk",
  "diners": "diners.com.pk",
  "edenrobe": "edenrobe.com",
  "servis": "servis.pk",
  "borjan": "borjan.com.pk",
  "alkaram": "alkaramstudio.com",
  "generation": "generation.com.pk",
  "walkeaze": "walkeaze.com",
  "1st step": "1ststep.pk",
  "khas": "khasstores.com",
  "engine": "engine.com.pk",
  "dhanak": "dhanak.com.pk",
  "lakhany": "lakhanyonline.com",
  "amir adnan": "amiradnan.com",
  "cross stitch": "crossstitch.pk",
  "insignia": "insignia.com.pk",
};

// ---- http helpers (global fetch, no deps) ----
async function http(url, timeout = 30000) {
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return Buffer.from(await r.arrayBuffer());
}

// og:image / logo HEAD-verify: 200 + image/* + not svg
async function headIsImage(url, timeout = 15000) {
  try {
    const r = await fetch(url, { method: "HEAD", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(timeout) });
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    return r.status === 200 && ct.startsWith("image") && !ct.includes("svg") && !url.toLowerCase().includes(".svg");
  } catch (e) {
    return false;
  }
}

// zlib.crc32 old Node versions mein nahi — chhota apna (spec-correct, python zlib.crc32 jaisa)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(s) {
  let c = 0 ^ -1;
  const b = Buffer.from(s, "utf8");
  for (let i = 0; i < b.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ b[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

// Shopify catalog: /products.json — brand ki REAL product photos (logo nahi).
async function brandProductImage(domain) {
  try {
    const raw = await http(`https://www.${domain}/products.json?limit=20`, 25000);
    const j = JSON.parse(raw.toString("utf8"));
    for (const p of j.products || []) {
      for (const im of p.images || []) {
        const src = (im.src || "").trim();
        if (src.startsWith("http")) return src.includes("?v=") ? src.split("?")[0] : src;
      }
    }
  } catch (e) { /* catalog closed/blocked — caller fallback pe jayega */ }
  return "";
}

// logo-type thumbnails pakarta hai (Shopify og:images aksar logo hi hote hain)
const LOGO_HINT = /logo|favicon|\.svg|_120x|_150x|120px|700x105|916x/i;

// dish-matched REAL photos — har URL curl-verified 200 image/jpeg
// (TheMealDB CDN + 3 Commons files jo CI pe proven hain). Pool mein se deal id
// pe rotate hota hai taake ek hi dish ke deals pe same photo na lage.
const DISH_IMG = {
  "biryani": ["https://www.themealdb.com/images/media/meals/xrttsx1487339558.jpg",
    "https://commons.wikimedia.org/wiki/Special:FilePath/Chicken_Biryani_combo.jpg?width=600"],
  "pulao": ["https://www.themealdb.com/images/media/meals/kos9av1699014767.jpg",
    "https://commons.wikimedia.org/wiki/Special:FilePath/Chicken_Biryani_combo.jpg?width=600"],
  "bbq": ["https://commons.wikimedia.org/wiki/Special:FilePath/BBQ_Platter.jpg?width=600",
    "https://www.themealdb.com/images/media/meals/04axct1763793018.jpg"],
  "barbecue": ["https://commons.wikimedia.org/wiki/Special:FilePath/BBQ_Platter.jpg?width=600"],
  "kabab": ["https://www.themealdb.com/images/media/meals/04axct1763793018.jpg"],
  "kebab": ["https://www.themealdb.com/images/media/meals/04axct1763793018.jpg"],
  "seekh": ["https://www.themealdb.com/images/media/meals/04axct1763793018.jpg"],
  "tikka": ["https://www.themealdb.com/images/media/meals/04axct1763793018.jpg",
    "https://commons.wikimedia.org/wiki/Special:FilePath/Grilled%20Chicken%20Tikka%20served%20on%20a%20sizzling%20platter%20with%20vegetables.jpg?width=600"],
  "grill": ["https://commons.wikimedia.org/wiki/Special:FilePath/Grilled%20Chicken%20Tikka%20served%20on%20a%20sizzling%20platter%20with%20vegetables.jpg?width=600",
    "https://www.themealdb.com/images/media/meals/04axct1763793018.jpg"],
  "turkish": ["https://www.themealdb.com/images/media/meals/04axct1763793018.jpg"],
  "karahi": ["https://www.themealdb.com/images/media/meals/wyxwsp1486979827.jpg"],
  "handi": ["https://www.themealdb.com/images/media/meals/wyxwsp1486979827.jpg"],
  "masala": ["https://www.themealdb.com/images/media/meals/wyxwsp1486979827.jpg"],
  "curry": ["https://www.themealdb.com/images/media/meals/sstssx1487349585.jpg"],
  "nihari": ["https://www.themealdb.com/images/media/meals/k07k271782502861.jpg"],
  "haleem": ["https://www.themealdb.com/images/media/meals/k07k271782502861.jpg"],
  "stew": ["https://www.themealdb.com/images/media/meals/k07k271782502861.jpg"],
  "mutton": ["https://www.themealdb.com/images/media/meals/k07k271782502861.jpg"],
  "fish": ["https://www.themealdb.com/images/media/meals/a15wsa1614349126.jpg",
    "https://www.themealdb.com/images/media/meals/ysxwuq1487323065.jpg"],
  "prawn": ["https://www.themealdb.com/images/media/meals/a15wsa1614349126.jpg"],
  "seafood": ["https://www.themealdb.com/images/media/meals/5r5rvx1763287943.jpg"],
  "burger": ["https://www.themealdb.com/images/media/meals/lgmnff1763789847.jpg",
    "https://www.themealdb.com/images/media/meals/44bzep1761848278.jpg"],
  "pizza": ["https://www.themealdb.com/images/media/meals/x0lk931587671540.jpg",
    "https://www.themealdb.com/images/media/meals/wf49qs1763075222.jpg"],
  "shawarma": ["https://www.themealdb.com/images/media/meals/kcv6hj1598733479.jpg",
    "https://www.themealdb.com/images/media/meals/swo87v1763595282.jpg"],
  "wrap": ["https://www.themealdb.com/images/media/meals/kcv6hj1598733479.jpg"],
  "roll": ["https://www.themealdb.com/images/media/meals/swo87v1763595282.jpg"],
  "noodle": ["https://www.themealdb.com/images/media/meals/2wx8cm1763373419.jpg"],
  "chowmein": ["https://www.themealdb.com/images/media/meals/2wx8cm1763373419.jpg"],
  "chinese": ["https://www.themealdb.com/images/media/meals/wuyd2h1765655837.jpg"],
  "fried rice": ["https://www.themealdb.com/images/media/meals/wuyd2h1765655837.jpg"],
  "rice": ["https://www.themealdb.com/images/media/meals/wuyd2h1765655837.jpg"],
  "sandwich": ["https://www.themealdb.com/images/media/meals/djdg8l1784578885.jpg"],
  "platter": ["https://commons.wikimedia.org/wiki/Special:FilePath/BBQ_Platter.jpg?width=600",
    "https://www.themealdb.com/images/media/meals/04axct1763793018.jpg"],
  "buffet": ["https://commons.wikimedia.org/wiki/Special:FilePath/BBQ_Platter.jpg?width=600"],
};

// Deal ke liye REAL picture: fashion brand ho to uski APNI product photo
// (Shopify /products.json) -> og:image (verified, relative URLs bhi) ->
// dish-matched photo (title/cuisine match, deal id se rotate) -> icon.horse
// logo (last resort).
async function brandImage(deal) {
  const t = (deal.t || "").toLowerCase();
  const fashion = (deal.cat || "").toLowerCase() === "fashion" ||
    ["clothing", "footwear", "fashion"].includes((deal.cuisine || "").toLowerCase());
  const domain = Object.entries(BRAND_SITES).find(([k]) => t.includes(k))?.[1] || null;
  if (domain) {
    // 1) fashion: brand ki APNI product photo (logo nahi — user demand)
    if (fashion) {
      const pi = await brandProductImage(domain);
      if (pi) return pi;
    }
    // 2) brand website ka og:image (real photo — CI network pe chalta hai)
    try {
      const html = (await http(`https://www.${domain}`, 20000)).toString("utf8");
      const m1 = html.match(/property=["']og:image["'][^>]*content=["']([^"']+)/);
      const m2 = html.match(/content=["']([^"']+)["'][^>]*property=["']og:image/);
      const om = m1 || m2;
      if (om) {
        let u = om[1].trim();
        if (u.startsWith("//")) u = "https:" + u;
        else if (u.startsWith("/")) u = `https://www.${domain}${u}`;
        if ((u.startsWith("https://") || u.startsWith("http://")) && await headIsImage(u)) return u;
      }
    } catch (e) { /* site blocked/slow — next fallback */ }
  }
  // 3) dish-matched real photo — pehle title, phir cuisine field
  for (const text of [t, (deal.cuisine || "").toLowerCase()]) {
    const keys = Object.keys(DISH_IMG).filter(k => text.includes(k)).sort((a, b) => b.length - a.length);
    if (keys.length) {
      const pool = DISH_IMG[keys[0]];
      return pool[(deal.id || 0) % pool.length];
    }
  }
  // 4) icon.horse — domain ka logo (last resort; food pe dish photo behtar)
  if (domain) {
    try {
      const r = await fetch(`https://icon.horse/icon/${domain}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      if (r.status === 200 && ct.startsWith("image")) return `https://icon.horse/icon/${domain}`;
    } catch (e) { /* skip */ }
  }
  return "";
}

// Fashion/clothing brand sales in Karachi — brandtijara.com (public, robots-allowed).
async function fetchBrandtijara() {
  const out = [];
  let html = "";
  try {
    html = (await http(BT_URL, 40000)).toString("utf8");
  } catch (e) {
    console.log(`  brandtijara fail: ${e.message}`);
    return out;
  }
  const pairs = [...html.matchAll(/href="(\/brands\/[a-z0-9-]+)">([^<]+)<span[^>]*>Up to (\d+)%<\/span><\/a>/g)];
  for (const [full, slug, brandRaw, pct] of pairs.slice(0, 25)) {
    const brand = brandRaw.trim();
    let thumb = "";
    try { // brand page ka og:image (public, keyless)
      const bhtml = (await http("https://www.brandtijara.com" + slug, 25000)).toString("utf8");
      const m1 = bhtml.match(/property="og:image"\s+content="(https:\/\/[^"]+)"/);
      const m2 = bhtml.match(/content="(https:\/\/[^"]+)"\s+property="og:image"/);
      if (m1 || m2) thumb = (m1 || m2)[1];
    } catch (e) { /* keep empty — thumbs loop bhar dega */ }
    out.push({
      "id": 50000 + out.length,
      "t": `${brand} — Sale up to ${pct}%`,
      "emoji": "👗",
      "area": "Karachi",
      "lat": 24.875, "lng": 67.035,
      "price": 0, "was": 0, "off": parseInt(pct, 10),
      "cuisine": "Fashion",
      "cat": "Fashion",
      "src": ["cr"],
      "hrs": 168,
      "addr": `${brand} outlets across Karachi — nearest branch map/link se`,
      "phone": "—",
      "time": "Live today",
      "note": `Up to ${pct}% off — brandtijara ne aaj check kiya (${brand} outlets Karachi mein).`,
      "links": { "gg": `https://www.google.com/maps/search/${brand}+Karachi`,
        "cr": `https://www.brandtijara.com${slug}` },
      "source": `https://www.brandtijara.com${slug}`,
      "thumb": thumb,
      "auto": true,
    });
  }
  return out;
}

// Shopify catalog sales: brand ki APNI site pe LIVE sale products — real price,
// real was-price, real product photo. Har deal pe picture guaranteed (user
// demand: bohot sari deals, sab pics ke sath). Sirf wahi stores jinke
// /products.json khule hain (khaadi/bonanza/cambridge closed — bt se aate hain).
const SHOPIFY_STORES = [
  ["bata.com.pk", "Bata", "👟"], ["hushpuppies.com.pk", "Hush Puppies", "👟"],
  ["servis.pk", "Servis", "👟"], ["borjan.com.pk", "Borjan", "👟"],
  ["limelight.pk", "Limelight", "👗"], ["outfitters.com.pk", "Outfitters", "👕"],
  ["gulahmedshop.com", "Gul Ahmed", "🧵"], ["diners.com.pk", "Diners", "👔"],
  ["edenrobe.com", "Edenrobe", "👔"], ["alkaramstudio.com", "Alkaram Studio", "👗"],
  ["generation.com.pk", "Generation", "👗"], ["walkeaze.com", "Walkeaze", "👟"],
  ["1ststep.pk", "1st Step", "👟"], ["khasstores.com", "Khas Stores", "👗"],
  ["engine.com.pk", "Engine", "👕"], ["dhanak.com.pk", "Dhanak", "🧕"],
  ["lakhanyonline.com", "Lakhany", "🧵"], ["amiradnan.com", "Amir Adnan", "👔"],
  ["crossstitch.pk", "Cross Stitch", "👗"], ["insignia.com.pk", "Insignia", "👟"],
];
const PER_STORE_CAP = 3;

async function fetchShopifySales() {
  const out = [];
  const seen = new Set();
  for (const [dom, brand, emo] of SHOPIFY_STORES) {
    let j;
    try {
      const raw = await http(`https://www.${dom}/products.json?limit=80`, 25000);
      j = JSON.parse(raw.toString("utf8"));
    } catch (e) { continue; }
    const sales = [];
    for (const p of j.products || []) {
      const handle = p.handle || "";
      if (!handle || seen.has(handle)) continue;
      let sv = null;
      for (const v of p.variants || []) {
        try {
          if (parseFloat(v.compare_at_price || 0) > parseFloat(v.price || 0)) { sv = v; break; }
        } catch (e) { /* skip variant */ }
      }
      if (!sv) continue;
      const price = Math.round(parseFloat(sv.price));
      const was = Math.round(parseFloat(sv.compare_at_price));
      if (!(price > 0) || was <= price || was < 1000) continue; // chhote prices skip
      const img = ((p.images || [])[0] || {}).src || "";
      if (!img.startsWith("http")) continue;
      const off = Math.round((1 - price / was) * 100);
      sales.push([off, price, was, img, handle, p.title || brand]);
    }
    sales.sort((a, b) => b[0] - a[0]); // sab se bara discount pehle
    for (const [off, price, was, img, handle, ptitle] of sales.slice(0, PER_STORE_CAP)) {
      seen.add(handle);
      out.push({
        "id": 60000 + crc32(handle) % 29999,
        "t": `${brand} — ${ptitle.slice(0, 52)} (was ${was} → ${price})`,
        "emoji": emo, "area": "Karachi (online)",
        "lat": 24.8607, "lng": 67.0011,
        "price": price, "was": was,
        "cuisine": emo === "👟" ? "Footwear" : "Clothing",
        "cat": "Fashion", "src": ["gg", "cr"], "hrs": 168,
        "addr": `${brand} — official site, delivery across Karachi`,
        "phone": "—",
        "time": "Online sale — jab tak stock hai",
        "note": `${brand} ki official site pe live sale: ${off}% off (${was} → ${price}).`,
        "links": { "web": `https://www.${dom}/products/${handle}`,
          "gg": `https://www.google.com/maps/search/${brand.replace(/ /g, "+")}+Karachi` },
        "source": `https://www.${dom}/products/${handle}`,
        "published": pktDate(),
        "thumb": img, "auto": true,
      });
    }
  }
  return out;
}

// Resolve a @handle to a channel id via the public channel page.
async function resolveChannelId(handle) {
  handle = handle.trim().replace(/^@/, "");
  const html = (await http(`https://www.youtube.com/@${handle}`, 30000)).toString("utf8");
  const m = html.match(/"externalId":"(UC[\w-]{20,24})"/) || html.match(/"channelId":"(UC[\w-]{20,24})"/);
  return m ? m[1] : null;
}

// PKT date (YYYY-MM-DD) — python now.date().isoformat() jaisa
function pktDate() {
  return new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
}
// PKT isoformat(seconds) — python now.isoformat(timespec="seconds") jaisa
function pktNowIso() {
  return new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 19) + "+05:00";
}

// '2 days ago' / '2 دن قبل' -> ISO timestamp. null agar unparseable
// (assuming 'now' made 8-month-old videos look fresh — real bug).
function ageToPublished(rel) {
  const unitsEn = { minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000, second: 1 };
  const unitsUr = { "سیکنڈ": 1, "منٹ": 60, "گھنٹہ": 3600, "گھنٹے": 3600, "دن": 86400,
    "ہفتہ": 604800, "ہفتے": 604800, "ماہ": 2592000, "سال": 31536000 };
  const m = (rel || "").match(/(\d+)\s*([a-zA-Z\u0600-\u06FF]+)\s*(?:ago|قبل|پہلے)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const mult = unitsEn[unit.toLowerCase()] || unitsUr[unit];
  if (!mult) return null;
  return new Date(Date.now() - n * mult * 1000).toISOString();
}

// Recent public videos from the channel /videos page (keyless, public).
async function fetchChannelVideos(cidOrHandle) {
  const url = cidOrHandle.startsWith("UC")
    ? `https://www.youtube.com/channel/${cidOrHandle}/videos`
    : `https://www.youtube.com/@${cidOrHandle.replace(/^@/, "")}/videos`;
  let html = "";
  try {
    html = (await http(url, 40000)).toString("utf8");
  } catch (e) {
    console.log(`  videos-page fail ${cidOrHandle}: ${e.message}`);
    return [];
  }
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/);
  if (!m) {
    console.log(`  no ytInitialData for ${cidOrHandle}`);
    return [];
  }
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch (e) {
    console.log(`  ytInitialData parse fail ${cidOrHandle}: ${e.message}`);
    return [];
  }
  const out = [];

  // Extract (id, title, published) from the new lockupViewModel layout.
  const fromLockup = (lv) => {
    try {
      const vid = lv.contentId;
      const title = lv.metadata.lockupMetadataViewModel.title.content;
      const parts = [];
      for (const row of lv.metadata.lockupMetadataViewModel.metadata?.contentMetadataViewModel?.metadataRows || []) {
        for (const p of row.metadataParts || []) parts.push(p.text?.content || "");
      }
      const pub = ageToPublished(parts.join(" "));
      if (!pub) return; // no real date -> reject (was showing as "fresh" — bug)
      out.push({ id: vid, t: title, published: pub });
    } catch (e) { /* skip */ }
  };

  const walk = (o) => {
    if (o && typeof o === "object" && !Array.isArray(o)) {
      if ("videoRenderer" in o) {
        const vr = o.videoRenderer;
        try {
          const vid = vr.videoId;
          const title = (vr.title.runs || []).map(r => r.text || "").join("");
          const rel = vr.publishedTimeText?.simpleText || "";
          const pub = ageToPublished(rel);
          if (pub) out.push({ id: vid, t: title, published: pub });
        } catch (e) { /* skip */ }
      }
      if ("lockupViewModel" in o) fromLockup(o.lockupViewModel);
      for (const v of Object.values(o)) walk(v);
    } else if (Array.isArray(o)) {
      for (const v of o) walk(v);
    }
  };
  walk(data);
  return out;
}

// Price nikalo: 'Rs 2299', 'Just 599', '450 Mey Pizza', '999/-'.
function extractPrice(title) {
  const ok = (s) => { const n = parseInt(s.replace(/,/g, ""), 10); return n >= 100 && n <= 100000 ? n : null; };
  let prices = [...title.matchAll(/rs\.?\s*([\d,]{3,6})/gi)].map(m => ok(m[1])).filter(x => x !== null);
  if (prices.length) return Math.min(...prices);
  let m = [...title.matchAll(/\b(?:just|only|sirf|mey|me|in|from|se)\s+([\d,]{3,6})\b/gi)];
  let nums = m.map(x => ok(x[1])).filter(x => x !== null);
  if (nums.length) return Math.min(...nums);
  m = [...title.matchAll(/([\d,]{3,6})\s*\/\s*-/g)];
  nums = m.map(x => ok(x[1])).filter(x => x !== null);
  if (nums.length) return Math.min(...nums);
  return 0;
}

// Fetch a video's watch page and pull its description (proper unicode decode).
async function videoDesc(vid) {
  let html = "";
  try {
    html = (await http(`https://www.youtube.com/watch?v=${vid}`, 40000)).toString("utf8");
  } catch (e) {
    return "";
  }
  const m = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
  if (!m) return "";
  try {
    return JSON.parse('"' + m[1] + '"');
  } catch (e) {
    return m[1];
  }
}

// maps.app.goo.gl short link -> (lat, lng) via redirect URL.
async function resolveMapsShortlink(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
    const final = r.url;
    const m = final.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || final.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (m) return [parseFloat(m[1]), parseFloat(m[2])];
  } catch (e) { /* skip */ }
  return null;
}

// Fill price/phone/address/area/links (real TikTok/Insta/Maps) from description.
async function enrichFromDesc(deal, desc) {
  if (!desc) return deal;
  deal.note = desc.slice(0, 180) + (desc.length > 180 ? "…" : "");
  const p = extractPrice(desc);
  if (p && !deal.price) deal.price = p;
  if (!deal.price) {
    const m = [...desc.matchAll(/([\d,]{3,6})\s*(?:rupees|روپے)/gi)];
    const nums = m.map(x => { const n = parseInt(x[1].replace(/,/g, ""), 10); return n >= 100 && n <= 100000 ? n : null; }).filter(x => x !== null);
    if (nums.length) deal.price = Math.min(...nums);
  }
  const pm = desc.match(/\b03\d{2}[-\s]?\d{7}\b/);
  if (pm) deal.phone = pm[0].replace(/ /g, "");
  // real Google Maps short link -> sources + coords
  const gm = desc.match(/https:\/\/maps\.app\.goo\.gl\/[\w-]+/);
  if (gm) {
    deal.links.gg = gm[0];
    if (!deal.src.includes("gg")) deal.src.push("gg");
    const coords = await resolveMapsShortlink(deal.links.gg);
    if (coords && 24.6 < coords[0] && coords[0] < 25.6 && 66.6 < coords[1] && coords[1] < 68.0) {
      deal.lat = coords[0]; deal.lng = coords[1];
      deal.addr = `Exact location map pe — ${deal.addr.length > 12 ? deal.addr : "link se kholo"}`;
    }
  }
  // real TikTok / Instagram from description
  const tm = desc.match(/https:\/\/www\.tiktok\.com\/@[\w.\-?=_]+/);
  if (tm) {
    deal.links.tt = tm[0].split("?")[0];
    if (!deal.src.includes("tt")) deal.src.push("tt");
  }
  const im = desc.match(/https:\/\/www\.instagram\.com\/[\w.\-]+\//);
  if (im) {
    deal.links.ig = im[0];
    if (!deal.src.includes("ig")) deal.src.push("ig");
  }
  // TikTok oEmbed thumbnail (keyless, public API) — deal ke liye real photo
  if (!deal.thumb && deal.links.tt) {
    try {
      const oe = JSON.parse((await http("https://www.tiktok.com/oembed?url=" + deal.links.tt, 20000)).toString("utf8"));
      const tu = oe.thumbnail_url || "";
      if (tu.startsWith("https://")) deal.thumb = tu;
    } catch (e) { /* skip */ }
  }
  // postal address line: a line mentioning Karachi + area keywords (not hashtags)
  for (const line of desc.split(/\r?\n/)) {
    const l = line.trim();
    if (l.startsWith("#") || l.includes("http") || l.length < 15) continue;
    if (/karachi/i.test(l) && /area|block|road|chowrangi|market|phase|sector|town/i.test(l)) {
      deal.addr = l.replace(/[#*📍🏷️]+/g, "").trim().slice(0, 120);
      break;
    }
  }
  const area = AREA_WORDS.find(a => desc.toLowerCase().includes(a.toLowerCase()));
  if (area) deal.area = area;
  return deal;
}

// Turn a YouTube video that looks like a deal post into a feed entry.
function videoToDeal(v, idx) {
  const title = v.t;
  const price = extractPrice(title);
  const area = AREA_WORDS.find(a => title.toLowerCase().includes(a.toLowerCase())) || "Karachi";
  const ageH = (Date.now() - Date.parse(v.published)) / 3600000;
  const hrs = Math.max(1, Math.min(168, Math.round(7 * 24 - ageH))); // feed window = 7 days
  return {
    "id": 10000 + idx,
    "t": title.slice(0, 110),
    "emoji": "🎥",
    "area": area,
    "lat": 24.875, "lng": 67.035, // city centre until enriched with real coords
    "price": price || 0,
    "was": 0,
    "cuisine": "Video Deal",
    "cat": classify(title),
    "src": ["yt"],
    "hrs": hrs,
    "addr": area,
    "phone": "—",
    "time": "—",
    "note": `Real video posted ${v.published.slice(0, 10)} — price/timing video mein confirm karein.`,
    "thumb": `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
    "links": { "yt": `https://www.youtube.com/watch?v=${v.id}` },
    "auto": true,
  };
}

async function main() {
  const curated = fs.existsSync(CURATED) ? JSON.parse(fs.readFileSync(CURATED, "utf8")) : { deals: [] };

  const channels = fs.readFileSync(CHANNELS_FILE, "utf8").split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  const idsPath = path.join(DATA, "channel_ids.json");
  const ids = fs.existsSync(idsPath) ? JSON.parse(fs.readFileSync(idsPath, "utf8")) : {};

  // enrichment cache: videoId -> extra fields (price/phone/addr/coords/links)
  const cachePath = path.join(DATA, "deal_cache.json");
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : {};

  const fresh = [];
  let idx = 1;
  const seen = new Set();
  for (const h of channels) {
    let cid = ids[h];
    if (!cid) {
      try { cid = await resolveChannelId(h); } catch (e) { cid = null; }
    }
    if (!cid) {
      console.log(`  handle resolve FAIL: ${h}`);
      continue;
    }
    ids[h] = cid;
    console.log(`  ${h} -> ${cid}`);
    for (const v of await fetchChannelVideos(cid)) {
      const ageMs = Date.now() - Date.parse(v.published);
      if (ageMs > 7 * 86400 * 1000 || seen.has(v.id)) continue;
      if (!DEAL_WORDS.test(v.t) || !(FOOD_WORDS.test(v.t) || FASHION_WORDS.test(v.t))) continue;
      seen.add(v.id);
      let d = videoToDeal(v, idx);
      if (cache[v.id]) {
        // cached enrichment (phone/coords/links) dobara apply karo
        for (const [k, val] of Object.entries(cache[v.id])) {
          if (!["t", "hrs", "published"].includes(k)) d[k] = val;
        }
      } else {
        d = await enrichFromDesc(d, await videoDesc(v.id));
        cache[v.id] = {};
        for (const k of ["price", "phone", "addr", "lat", "lng", "links", "src", "area"]) if (k in d) cache[v.id][k] = d[k];
      }
      fresh.push(d);
      idx += 1;
    }
  }
  fs.writeFileSync(idsPath, JSON.stringify(ids, null, 1));
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 1));

  // curated deals: default category Food agar missing hai
  for (const d of curated.deals) if (!d.cat) d.cat = "Food";
  const bt = await fetchBrandtijara();
  const shop = await fetchShopifySales();
  const deals = curated.deals.concat(bt, shop, fresh);
  // thumbnails: har deal pe ek image honi chahiye — yt/shorts link se derive karo
  const YTID = /(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/;
  for (const d of deals) {
    // fashion: brand ki APNI product photo (Shopify catalog) — logo/favicon
    // thumbnails card mein blur/phaate lagte hain (user complaint).
    const isfash = (d.cat || "").toLowerCase() === "fashion" ||
      ["Clothing", "Footwear", "Fashion"].includes(d.cuisine || "");
    if (isfash) {
      const dom = Object.entries(BRAND_SITES).find(([k]) => (d.t || "").toLowerCase().includes(k))?.[1];
      if (dom) {
        const pi = await brandProductImage(dom);
        if (pi) d.thumb = pi;
      }
    }
    if (!d.thumb && d.links && d.links.yt) {
      const m = d.links.yt.match(YTID);
      if (m) d.thumb = `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg`;
    }
    // bina image wali deals: brand ki picture internet se (og:image / logo / dish photo)
    if (!d.thumb) d.thumb = await brandImage(d);
  }
  const out = {
    "app": "Karachi Pulse",
    "updated": pktNowIso(),
    "version": 3,
    "deals": deals,
  };
  fs.writeFileSync(DEALS, JSON.stringify(out, null, 1));
  console.log(`OK: ${curated.deals.length} curated + ${bt.length} brand sales + ${shop.length} shopify sale products + ${fresh.length} fresh video deals = ${deals.length} total, updated ${out.updated}`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });

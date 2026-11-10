#!/usr/bin/env python3
"""
Karachi Pulse — real deal ingestion (runs daily on GitHub Actions).

Sources (all public, keyless, ToS-respecting):
  1. YouTube public RSS feeds of configured Karachi food channels
     (feeds/videos.xml is YouTube's official public feed endpoint).
  2. data/curated.json — hand-captured deals (real restaurants/prices/links,
     captured from public menu pages & posts). These are the "verified" base.

Output: data/deals.json (the live feed the app fetches every refresh).

Nothing here is scraped behind login walls; no API keys are needed.
"""
import json, re, sys, urllib.request, datetime, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DEALS = DATA / "deals.json"
CURATED = DATA / "curated.json"
CHANNELS_FILE = DATA / "channels.txt"
UA = {"User-Agent": "Mozilla/5.0 (compatible; KarachiPulse/2.0)"}
PKT = datetime.timezone(datetime.timedelta(hours=5))

# videos must mention a deal-ish keyword to become an app deal
DEAL_WORDS = re.compile(r"\b(deal|deals|offer|sale|buffet|platter|free|discount|combo|price|rs\.?)\b", re.I)
# food context filter — market/crockery/gadget videos ko rokta hai
FOOD_WORDS = re.compile(r"food|biryani|pizza|burger|buffet|karahi|bbq|platter|roll|kabab|kebab|dessert|ice\s?cream|chai|nihari|broast|fries|shawarma|manda|mandi|pulao|biryani|chat|chaat|sweets|bakery|iftar|drink|juice|fried|grill|steak|sandwich|wrap|paratha|chicken|mutton|beef|fish", re.I)
# fashion/clothing/shopping keywords
FASHION_WORDS = re.compile(r"kurti|kurta|lawn|unstitched|pret|suit|suits|kapray|kapre|clothes|clothing|shoes|sandal|sneaker|jeans|shirt|frock|hoodie|sweatshirt|bag|purse|makeup|cosmetic|perfume|jewellery|jewelry|watch|sale|sale\b|bazaar|market|mall|outlet|brand|wear|fashion|crocery|grocery|crockery|gadget|mobile|phone|shopping|kitchen", re.I)
PRICE_RE = re.compile(r"rs\.?\s*([\d,]{3,6})", re.I)
AREA_WORDS = ["DHA", "Clifton", "Gulshan", "Nazimabad", "Bahadurabad", "Saddar",
              "Malir", "Samanabad", "Federal B", "North Nazimabad", "Karachi"]


def classify(text):
    """Deal text -> category."""
    if FOOD_WORDS.search(text):
        return "Food"
    if FASHION_WORDS.search(text):
        return "Fashion"
    return "Shopping"


BT_URL = "https://www.brandtijara.com/in-store/karachi"

# brand -> domain: deal title se brand pehchan kar us ki picture lagate hain
# (har deal pe picture chahiye — user demand; sources keyless hain)
BRAND_SITES = {
    "domino": "dominos.pk",
    "kababjees": "kababjees.com",
    "btb": "btbmore.com",
    "khaadi": "khaadi.com",
    "gul ahmed": "gulahmedshop.com",
    "limelight": "limelight.pk",
    "outfitters": "outfitters.com.pk",
    "bata": "bata.com.pk",
    "hashim food": "hashimfood.com",
}
# cuisine-matched real photos (Wikimedia Commons, CC-licensed) — brands with no
# known domain inke liye. Ingest HEAD-verify karta hai; fail ho to skip.
CUISINE_IMG = {
    "buffet": "https://commons.wikimedia.org/wiki/Special:FilePath/BBQ_Platter.jpg?width=600",
    "pulao": "https://commons.wikimedia.org/wiki/Special:FilePath/Chicken_Biryani_combo.jpg?width=600",
    "biryani": "https://commons.wikimedia.org/wiki/Special:FilePath/Chicken_Biryani_combo.jpg?width=600",
    "bbq": "https://commons.wikimedia.org/wiki/Special:FilePath/BBQ_Platter.jpg?width=600",
    "turkish": "https://commons.wikimedia.org/wiki/Special:FilePath/BBQ_Platter.jpg?width=600",
    "burger": "https://commons.wikimedia.org/wiki/Special:FilePath/Grilled%20Chicken%20Tikka%20served%20on%20a%20sizzling%20platter%20with%20vegetables.jpg?width=600",
    "grill": "https://commons.wikimedia.org/wiki/Special:FilePath/Grilled%20Chicken%20Tikka%20served%20on%20a%20sizzling%20platter%20with%20vegetables.jpg?width=600",
    "fish": "https://commons.wikimedia.org/wiki/Special:FilePath/Grilled%20Chicken%20Tikka%20served%20on%20a%20sizzling%20platter%20with%20vegetables.jpg?width=600",
}


def brand_image(deal):
    """Deal ke liye picture dhoondo: brand site og:image -> icon.horse logo -> cuisine photo."""
    t = (deal.get("t") or "").lower()
    domain = next((d for k, d in BRAND_SITES.items() if k in t), None)
    if domain:
        # 1) brand website ka og:image (real photo — CI network pe chalta hai)
        try:
            html = http(f"https://www.{domain}", timeout=20).decode("utf-8", "ignore")
            om = re.search(r'property=["\']og:image["\'][^>]*content=["\'](https://[^"\']+)', html) or \
                 re.search(r'content=["\'](https://[^"\']+)["\'][^>]*property=["\']og:image', html)
            if om:
                return om.group(1)
        except Exception:
            pass
        # 2) icon.horse — domain ka logo (keyless, verified working)
        try:
            req = urllib.request.Request(f"https://icon.horse/icon/{domain}", headers=UA)
            with urllib.request.urlopen(req, timeout=20) as r:
                if r.status == 200 and (r.headers.get("Content-Type") or "").startswith("image"):
                    return f"https://icon.horse/icon/{domain}"
        except Exception:
            pass
    # 3) cuisine-matched Commons photo (HEAD-verify; fail -> skip)
    for key, url in CUISINE_IMG.items():
        if key in t:
            try:
                req = urllib.request.Request(url, headers=UA, method="HEAD")
                with urllib.request.urlopen(req, timeout=20) as r:
                    if r.status == 200:
                        return url
            except Exception:
                pass
            break
    return ""


def fetch_brandtijara():
    """Fashion/clothing brand sales in Karachi — brandtijara.com (public, robots-allowed,
    daily-checked data). Returns list of deals."""
    try:
        html = http(BT_URL, timeout=40).decode("utf-8", "ignore")
    except Exception as e:
        print(f"  brandtijara fail: {e}")
        return []
    pairs = re.findall(r'href="(/brands/[a-z0-9-]+)">([^<]+)<span[^>]*>Up to (\d+)%</span></a>', html)
    out = []
    for i, (slug, brand, pct) in enumerate(pairs[:25]):
        brand = brand.strip()
        thumb = ""
        try:  # brand page ka og:image = real store photo/logo (public, keyless)
            bhtml = http("https://www.brandtijara.com" + slug, timeout=25).decode("utf-8", "ignore")
            om = re.search(r'property="og:image"\s+content="(https://[^"]+)"', bhtml) or \
                 re.search(r'content="(https://[^"]+)"\s+property="og:image"', bhtml)
            if om:
                thumb = om.group(1)
        except Exception:
            pass
        out.append({
            "id": 50000 + i,
            "t": f"{brand} — Sale up to {pct}%",
            "emoji": "👗",
            "area": "Karachi",
            "lat": 24.875, "lng": 67.035,
            "price": 0, "was": 0,
            "cuisine": "Fashion",
            "cat": "Fashion",
            "src": ["cr"],
            "hrs": 168,
            "addr": f"{brand} outlets across Karachi — nearest branch map/link se",
            "phone": "—",
            "time": "Live today",
            "note": f"Up to {pct}% off — brandtijara ne aaj check kiya ({brand} outlets Karachi mein).",
            "links": {"gg": f"https://www.google.com/maps/search/{brand}+Karachi"},
            "source": f"https://www.brandtijara.com{slug}",
            "thumb": thumb,
            "auto": True,
            "cat": "Fashion",
        })
    return out


def http(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def resolve_channel_id(handle):
    """Resolve a @handle to a channel id via the public channel page."""
    handle = handle.strip().lstrip("@")
    html = http(f"https://www.youtube.com/@{handle}", timeout=30).decode("utf-8", "ignore")
    m = re.search(r'"externalId":"(UC[\w-]{20,24})"', html) or re.search(r'"channelId":"(UC[\w-]{20,24})"', html)
    return m.group(1) if m else None


def parse_iso(ts):
    return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))


def age_to_published(rel):
    """'2 days ago' / '2 دن قبل' -> ISO timestamp. Returns None if unparseable
    (assuming 'now' made 8-month-old videos look fresh — real bug)."""
    units_en = {"minute": 60, "hour": 3600, "day": 86400, "week": 604800,
                "month": 2592000, "year": 31536000, "second": 1}
    units_ur = {"سیکنڈ": 1, "منٹ": 60, "گھنٹہ": 3600, "گھنٹے": 3600, "دن": 86400,
                "ہفتہ": 604800, "ہفتے": 604800, "ماہ": 2592000, "سال": 31536000}
    m = re.search(r"(\d+)\s*([a-zA-Z\u0600-\u06FF]+)\s*(?:ago|قبل|پہلے)", rel or "")
    if not m:
        return None
    n = int(m.group(1))
    unit = m.group(2)
    mult = units_en.get(unit.lower()) or units_ur.get(unit)
    if mult is None:
        return None
    dt = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=n * mult)
    return dt.isoformat()


def fetch_channel_videos(cid_or_handle):
    """Recent public videos from the channel /videos page (keyless, public)."""
    if cid_or_handle.startswith("UC"):
        url = f"https://www.youtube.com/channel/{cid_or_handle}/videos"
    else:
        url = f"https://www.youtube.com/@{cid_or_handle.lstrip('@')}/videos"
    try:
        html = http(url, timeout=40).decode("utf-8", "ignore")
    except Exception as e:
        print(f"  videos-page fail {cid_or_handle}: {e}")
        return []
    m = re.search(r"var ytInitialData = (\{.*?\});</script>", html)
    if not m:
        print(f"  no ytInitialData for {cid_or_handle}")
        return []
    try:
        data = json.loads(m.group(1))
    except Exception as e:
        print(f"  ytInitialData parse fail {cid_or_handle}: {e}")
        return []
    out = []

    def from_lockup(lv):
        """Extract (id, title, published) from the new lockupViewModel layout."""
        try:
            vid = lv["contentId"]
            title = lv["metadata"]["lockupMetadataViewModel"]["title"]["content"]
            parts = []
            for row in lv["metadata"]["lockupMetadataViewModel"].get("metadata", {}).get("contentMetadataViewModel", {}).get("metadataRows", []):
                for p in row.get("metadataParts", []):
                    parts.append(p.get("text", {}).get("content", ""))
            rel = " ".join(parts)
            pub = age_to_published(rel)
            if pub is None:
                return  # no real date -> reject (was showing as "fresh" — bug)
            out.append({"id": vid, "t": title, "published": pub})
        except Exception:
            pass

    def walk(o):
        if isinstance(o, dict):
            if "videoRenderer" in o:
                vr = o["videoRenderer"]
                try:
                    vid = vr["videoId"]
                    title = "".join(r.get("text", "") for r in vr["title"]["runs"])
                    rel = vr.get("publishedTimeText", {}).get("simpleText", "")
                    pub = age_to_published(rel)
                    if pub is None:
                        pass  # no real date -> skip
                    else:
                        out.append({"id": vid, "t": title, "published": pub})
                except Exception:
                    pass
            if "lockupViewModel" in o:
                from_lockup(o["lockupViewModel"])
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(data)
    return out


def extract_price(title):
    """Price nikalo: 'Rs 2299', 'Just 599', '450 Mey Pizza', '999/-'."""
    prices = [int(p.replace(",", "")) for p in PRICE_RE.findall(title)]
    prices = [p for p in prices if 100 <= p <= 100000]
    if prices:
        return min(prices)
    m = re.findall(r"\b(?:just|only|sirf|mey|me|in|from|se)\s+([\d,]{3,6})\b", title, re.I)
    nums = [int(x.replace(",", "")) for x in m if 100 <= int(x.replace(",", "")) <= 100000]
    if nums:
        return min(nums)
    m = re.findall(r"([\d,]{3,6})\s*/\s*-", title)
    nums = [int(x.replace(",", "")) for x in m if 100 <= int(x.replace(",", "")) <= 100000]
    if nums:
        return min(nums)
    return 0


def video_desc(vid):
    """Fetch a video's watch page and pull its description (proper unicode decode)."""
    try:
        html = http(f"https://www.youtube.com/watch?v={vid}", timeout=40).decode("utf-8", "ignore")
    except Exception:
        return ""
    m = re.search(r'"shortDescription":"((?:[^"\\]|\\.)*)"', html)
    if not m:
        return ""
    try:
        return json.loads('"' + m.group(1) + '"')
    except Exception:
        return m.group(1).encode().decode("unicode_escape", errors="ignore")


def resolve_maps_shortlink(url):
    """maps.app.goo.gl short link -> (lat, lng) via redirect URL."""
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=30) as r:
            final = r.geturl()
        m = re.search(r"@(-?\d+\.\d+),(-?\d+\.\d+)", final) or re.search(r"!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)", final)
        if m:
            return float(m.group(1)), float(m.group(2))
    except Exception:
        pass
    return None


def enrich_from_desc(deal, desc):
    """Fill price/phone/address/area/links (real TikTok/Insta/Maps) from description."""
    if not desc:
        return deal
    deal["note"] = (desc[:180] + ("…" if len(desc) > 180 else ""))
    p = extract_price(desc)
    if p and not deal["price"]:
        deal["price"] = p
    if not deal["price"]:
        m = re.findall(r"([\d,]{3,6})\s*(?:rupees|روپے)", desc, re.I)
        nums = [int(x.replace(",", "")) for x in m if 100 <= int(x.replace(",", "")) <= 100000]
        if nums:
            deal["price"] = min(nums)
    m = re.search(r"\b03\d{2}[-\s]?\d{7}\b", desc)
    if m:
        deal["phone"] = m.group(0).replace(" ", "")
    # real Google Maps short link -> sources + coords
    gm = re.search(r"https://maps\.app\.goo\.gl/[\w-]+", desc)
    if gm:
        deal["links"]["gg"] = gm.group(0)
        if "gg" not in deal["src"]:
            deal["src"].append("gg")
        coords = resolve_maps_shortlink(deal["links"]["gg"])
        if coords and 24.6 < coords[0] < 25.6 and 66.6 < coords[1] < 68.0:
            deal["lat"], deal["lng"] = coords
            deal["addr"] = f"Exact location map pe — {deal['addr'] if len(deal['addr'])>12 else 'link se kholo'}"
    # real TikTok / Instagram from description
    tm = re.search(r"https://www\.tiktok\.com/@[\w.\-?=_]+", desc)
    if tm:
        deal["links"]["tt"] = tm.group(0).split("?")[0]
        if "tt" not in deal["src"]:
            deal["src"].append("tt")
    im = re.search(r"https://www\.instagram\.com/[\w.\-]+/", desc)
    if im:
        deal["links"]["ig"] = im.group(0)
        if "ig" not in deal["src"]:
            deal["src"].append("ig")
    # TikTok oEmbed thumbnail (keyless, public API) — deal ke liye real photo
    if not deal.get("thumb") and deal["links"].get("tt"):
        try:
            oe = json.loads(http("https://www.tiktok.com/oembed?url=" + deal["links"]["tt"], timeout=20).decode("utf-8", "ignore"))
            tu = oe.get("thumbnail_url", "")
            if tu.startswith("https://"):
                deal["thumb"] = tu
        except Exception:
            pass
    # postal address line: a line mentioning Karachi + area keywords (not hashtags)
    for line in desc.splitlines():
        l = line.strip()
        if l.startswith("#") or "http" in l or len(l) < 15:
            continue
        if re.search(r"karachi", l, re.I) and re.search(r"area|block|road|chowrangi|market|phase|sector|town", l, re.I):
            deal["addr"] = re.sub(r"[#*📍🏷️]+", "", l).strip()[:120]
            break
    area = next((a for a in AREA_WORDS if a.lower() in desc.lower()), None)
    if area:
        deal["area"] = area
    return deal


def video_to_deal(v, idx):
    """Turn a YouTube video that looks like a deal post into a feed entry."""
    title = v["t"]
    price = extract_price(title)
    area = next((a for a in AREA_WORDS if a.lower() in title.lower()), "Karachi")
    age = datetime.datetime.now(datetime.timezone.utc) - parse_iso(v["published"])
    hrs = max(1, min(168, int(7 * 24 - age.total_seconds() / 3600)))  # feed window = 7 days
    return {
        "id": 10000 + idx,
        "t": title[:110],
        "emoji": "🎥",
        "area": area,
        "lat": 24.875, "lng": 67.035,  # city centre until curated with real coords
        "price": price or 0,
        "was": 0,
        "cuisine": "Video Deal",
        "cat": classify(title),
        "src": ["yt"],
        "hrs": hrs,
        "addr": area,
        "phone": "—",
        "time": "—",
        "note": f"Real video posted {v['published'][:10]} — price/timing video mein confirm karein.",
        "thumb": f"https://i.ytimg.com/vi/{v['id']}/hqdefault.jpg",
        "links": {"yt": f"https://www.youtube.com/watch?v={v['id']}"},
        "auto": True,
    }


def main():
    now = datetime.datetime.now(PKT)
    curated = json.load(open(CURATED, encoding="utf-8")) if CURATED.exists() else {"deals": []}

    channels = [l.strip() for l in CHANNELS_FILE.read_text().splitlines() if l.strip() and not l.startswith("#")]
    ids_path = DATA / "channel_ids.json"
    ids = json.load(open(ids_path)) if ids_path.exists() else {}

    # enrichment cache: videoId -> extra fields (price/phone/addr/coords/links)
    cache_path = DATA / "deal_cache.json"
    cache = json.load(open(cache_path)) if cache_path.exists() else {}

    fresh = []
    idx = 1
    seen = set()
    for h in channels:
        cid = ids.get(h) or resolve_channel_id(h)
        if not cid:
            print(f"  handle resolve FAIL: {h}")
            continue
        ids[h] = cid
        print(f"  {h} -> {cid}")
        for v in fetch_channel_videos(cid):
            age = datetime.datetime.now(datetime.timezone.utc) - parse_iso(v["published"])
            if age.total_seconds() > 7 * 86400 or v["id"] in seen:
                continue
            if not DEAL_WORDS.search(v["t"]) or not (FOOD_WORDS.search(v["t"]) or FASHION_WORDS.search(v["t"])):
                continue
            seen.add(v["id"])
            d = video_to_deal(v, idx)
            if v["id"] in cache:
                # cached enrichment (phone/coords/links) dobara apply karo
                for k, val in cache[v["id"]].items():
                    if k not in ("t", "hrs", "published"):
                        d[k] = val
                d["t"] = video_to_deal(v, idx)["t"]
            else:
                d = enrich_from_desc(d, video_desc(v["id"]))
                cache[v["id"]] = {k: d[k] for k in ("price", "phone", "addr", "lat", "lng", "links", "src", "area") if k in d}
            fresh.append(d)
            idx += 1
    ids_path.write_text(json.dumps(ids, indent=1))
    cache_path.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")

    ids_path.parent.mkdir(exist_ok=True)
    # curated deals: default category Food agar missing hai
    for d in curated["deals"]:
        d.setdefault("cat", "Food")
    bt = fetch_brandtijara()
    deals = curated["deals"] + bt + fresh
    # thumbnails: har deal pe ek image honi chahiye — yt/shorts link se derive karo
    YTID = re.compile(r"(?:v=|youtu\.be/|shorts/|embed/|live/)([\w-]{11})")
    for d in deals:
        if not d.get("thumb") and (d.get("links") or {}).get("yt"):
            m = YTID.search(d["links"]["yt"])
            if m:
                d["thumb"] = f"https://i.ytimg.com/vi/{m.group(1)}/hqdefault.jpg"
        # bina image wali deals: brand ki picture internet se (og:image / logo / cuisine photo)
        if not d.get("thumb"):
            d["thumb"] = brand_image(d)
    out = {
        "app": "Karachi Pulse",
        "updated": now.isoformat(timespec="seconds"),
        "version": 3,
        "deals": deals,
    }
    DEALS.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"OK: {len(curated['deals'])} curated + {len(bt)} brand sales + {len(fresh)} fresh video deals = {len(deals)} total, updated {out['updated']}")


if __name__ == "__main__":
    main()

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
PRICE_RE = re.compile(r"rs\.?\s*([\d,]{3,6})", re.I)
AREA_WORDS = ["DHA", "Clifton", "Gulshan", "Nazimabad", "Bahadurabad", "Saddar",
              "Malir", "Samanabad", "Federal B", "North Nazimabad", "Karachi"]


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


def fetch_channel_videos(channel_id):
    """Return recent public videos from the official RSS feed."""
    try:
        xml = http(f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}", timeout=30).decode("utf-8", "ignore")
    except Exception as e:
        print(f"  feed fail {channel_id}: {e}")
        return []
    out = []
    for entry in re.findall(r"<entry>(.*?)</entry>", xml, re.S):
        vid = re.search(r"<yt:videoId>([\w-]{11})</yt:videoId>", entry)
        title = re.search(r"<title>(.*?)</title>", entry)
        pub = re.search(r"<published>(.*?)</published>", entry)
        if not (vid and title and pub):
            continue
        out.append({"id": vid.group(1), "t": title.group(1), "published": pub.group(1)})
    return out


def video_to_deal(v, idx):
    """Turn a YouTube video that looks like a deal post into a feed entry."""
    title = v["t"]
    prices = [int(p.replace(",", "")) for p in PRICE_RE.findall(title)]
    price = min([p for p in prices if 100 <= p <= 100000], default=0)
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
        "src": ["yt"],
        "hrs": hrs,
        "addr": area,
        "phone": "—",
        "time": "—",
        "note": f"Real video posted {v['published'][:10]} — price/timing video mein confirm karein.",
        "links": {"yt": f"https://www.youtube.com/watch?v={v['id']}"},
        "auto": True,
    }


def main():
    now = datetime.datetime.now(PKT)
    curated = json.load(open(CURATED, encoding="utf-8")) if CURATED.exists() else {"deals": []}

    channels = [l.strip() for l in CHANNELS_FILE.read_text().splitlines() if l.strip() and not l.startswith("#")]
    ids_path = DATA / "channel_ids.json"
    ids = json.load(open(ids_path)) if ids_path.exists() else {}

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
            if not DEAL_WORDS.search(v["t"]):
                continue
            seen.add(v["id"])
            fresh.append(video_to_deal(v, idx))
            idx += 1
    ids_path.write_text(json.dumps(ids, indent=1))

    ids_path.parent.mkdir(exist_ok=True)
    deals = curated["deals"] + fresh
    out = {
        "app": "Karachi Pulse",
        "updated": now.isoformat(timespec="seconds"),
        "version": 3,
        "deals": deals,
    }
    DEALS.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"OK: {len(curated['deals'])} curated + {len(fresh)} fresh video deals = {len(deals)} total, updated {out['updated']}")


if __name__ == "__main__":
    main()

import sys
sys.path.insert(0, 'ingest')
from ingest import resolve_channel_id, fetch_channel_videos, DEAL_WORDS
from datetime import datetime, timezone

for h in ['VlogCentralTv', 'iFoodMania-IFM', 'MarketBhai.', 'tehseenkhan8087', 'FoodFusionPK', 'StreetFoodPKofficial']:
    try:
        cid = resolve_channel_id(h)
        if not cid:
            print(f'{h}: RESOLVE FAIL')
            continue
        vs = fetch_channel_videos(cid)
        recent_deals = 0
        for v in vs:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(v['published'])).days
            if age <= 7 and DEAL_WORDS.search(v['t']):
                recent_deals += 1
        newest = min((datetime.now(timezone.utc) - datetime.fromisoformat(v['published'])).days for v in vs) if vs else None
        print(f'{h}: {cid} | videos={len(vs)} | newest={newest}d | recent-deals<=7d={recent_deals}')
    except Exception as e:
        print(f'{h}: ERROR {str(e)[:80]}')

import sys, re, json
sys.path.insert(0, 'ingest')
from ingest import http

html = http('https://www.youtube.com/channel/UC6YDmivVpEX7mRMRvWp2JPw/videos', timeout=40).decode('utf-8', 'ignore')
data = json.loads(re.search(r'var ytInitialData = (\{.*?\});</script>', html).group(1))

from collections import Counter
keys_found = []
def find_keys(o, keys, depth=0, path=''):
    if depth > 14:
        return
    if isinstance(o, dict):
        for k, v in o.items():
            if k in keys:
                keys_found.append(k)
            find_keys(v, keys, depth + 1)
    elif isinstance(o, list):
        for v in o:
            find_keys(v, keys, depth + 1)
find_keys(data, {'richItemRenderer', 'lockupViewModel', 'videoRenderer', 'videoWithContextRenderer'})
print(Counter(keys_found))

def find_first(o, key):
    if isinstance(o, dict):
        if key in o:
            return o[key]
        for v in o.values():
            r = find_first(v, key)
            if r is not None:
                return r
    elif isinstance(o, list):
        for v in o:
            r = find_first(v, key)
            if r is not None:
                return r
    return None

rir = find_first(data, 'richItemRenderer')
if rir:
    lv = rir.get('content', {}).get('lockupViewModel', {})
    meta = lv.get('metadata', {})
    print('lockup keys:', list(lv.keys())[:8])
    print('metadata keys:', list(meta.keys())[:8])
    # title
    mdv = meta.get('lockupMetadataViewModel', {})
    print('title:', json.dumps(mdv.get('title', {}))[:200])
    # metadata parts (published time etc)
    print('metadata dump:', json.dumps(meta)[:900])
    # thumbnail video id
    img = lv.get('contentImage', {}).get('thumbnailViewModel', {}).get('image', {}).get('sources', [])
    if img:
        print('thumb url sample:', img[0]['url'][:80])
    # contentId
    print('contentId:', lv.get('contentId'))

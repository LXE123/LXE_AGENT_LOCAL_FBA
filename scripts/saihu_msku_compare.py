"""Isolated, read-only source validation. Never writes production dataset directories.

Run from repository root with uv run python scripts/saihu_msku_compare.py.
Raw business data belongs in an ignored output directory, never in git fixtures.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import time
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

import requests


def now():
    return datetime.now(timezone.utc).isoformat()


def redact(value, secrets=()):
    if isinstance(value, dict):
        return {k: '[REDACTED]' if re.search(r'authorization|cookie|token|secret|password|signature|api.?key|^sign$', k, re.I) else redact(v, secrets) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v, secrets) for v in value]
    if isinstance(value, str):
        for secret in secrets:
            if secret:
                value = value.replace(secret, '[REDACTED]')
        return re.sub(r'Bearer\s+\S+', 'Bearer [REDACTED]', value, flags=re.I)
    return value


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=str))


def load_env(path):
    for line in path.read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            if key.strip().startswith('LXE_DATA_SERVER_'):
                os.environ[key.strip()] = value.strip().strip('\"').strip("'")


class Client:
    def __init__(self, output):
        self.output = output
        self.base = os.environ.get('LXE_DATA_SERVER_PRIVATE_URL') or os.environ['LXE_DATA_SERVER_URL']
        self.key = os.environ['LXE_DATA_SERVER_API_KEY']
        self.session = requests.Session()
        self.session.trust_env = False
        self.calls = json.loads((output/'requests.json').read_text()) if (output/'requests.json').exists() else []

    def post(self, provider, endpoint, body):
        url = self.base.rstrip('/') + '/api/v1/data-sources/' + provider + '/' + endpoint
        for attempt in range(3):
            record = dict(provider=provider, endpoint=endpoint, body=body, started=now(), attempt=attempt + 1)
            start = time.monotonic()
            try:
                response = self.session.post(url, json=body, headers={'Authorization': 'Bearer ' + self.key}, timeout=60)
                record['http_status'] = response.status_code
                try:
                    data = response.json()
                except ValueError:
                    data = {'raw_response': response.text}
                record['response'] = redact(data, [self.key])
                ok_code = '0' if provider == 'saihu' else '200'
                if response.status_code == 200 and str(data.get('code')) == ok_code:
                    return data
                # An explicit business failure must not be hidden by transient retries.
                retry = response.status_code == 429 or (response.status_code in (502, 503, 504) and not self.business_failure(data, ok_code))
                if not retry or attempt == 2:
                    raise RuntimeError(f'{provider}/{endpoint} HTTP {response.status_code}: ' + self.error_text(data))
                from services.mabang.official_api import retry_delay
                delay = retry_delay(response.headers.get('Retry-After'), attempt + 1)
            except (requests.ConnectionError, requests.Timeout) as exc:
                record['exception'] = redact(str(exc), [self.key])
                if attempt == 2:
                    raise RuntimeError(f'{provider}/{endpoint}: {record["exception"]}') from exc
                delay = attempt + 1
            finally:
                record.update(ended=now(), seconds=round(time.monotonic() - start, 3))
                self.calls.append(record)
                save(self.output / 'raw' / f'{len(self.calls):04d}-{provider}-{endpoint.replace("/", "_")}.json', record)
                save(self.output / 'requests.json', [{k:v for k,v in r.items() if k != 'response'} for r in self.calls])
            time.sleep(min(delay, 60))

    def error_text(self, value):
        text = json.dumps(redact(value, [self.key]), ensure_ascii=False)
        return text if len(text) <= 4000 else text[:4000] + f' [truncated {len(text)-4000} chars]'

    @staticmethod
    def business_failure(value, success):
        return isinstance(value, dict) and (('code' in value and str(value['code']) != success) or any(Client.business_failure(value.get(k), success) for k in ('detail', 'upstream', 'body')))


def integer(value):
    if isinstance(value, bool) or not re.fullmatch(r'\d+', str(value)):
        raise ValueError(f'Invalid pagination integer: {value!r}')
    return int(value)


def pages(client, endpoint, body, *, shop=None, marketplace=None):
    result, seen, totals = [], set(), None
    page = 1
    while True:
        payload = client.post('saihu', endpoint, dict(body, pageNo=str(page)))
        data = payload.get('data')
        if not isinstance(data, dict) or not isinstance(data.get('rows'), list):
            raise ValueError(f'{endpoint}: missing data.rows')
        size, total, count, current = [integer(data[k]) for k in ('pageSize', 'totalSize', 'totalPage', 'pageNo')]
        if size < 1 or current != page or count not in ({0,1} if total == 0 else {(total + size - 1)//size}):
            raise ValueError(f'{endpoint}: contradictory pagination')
        if totals is not None and totals != (size,total,count):
            raise ValueError(f'{endpoint}: totals changed during pagination')
        totals = size,total,count
        rows = data['rows']
        if len(rows) != min(size, total - len(result)):
            raise ValueError(f'{endpoint}: row count contradicts total')
        fingerprint = hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()
        if fingerprint in seen:
            raise ValueError(f'{endpoint}: repeated page')
        seen.add(fingerprint)
        for row in rows:
            shop_ids = row.get('shopIdList') if endpoint == 'product-analysis/v2' else [str(row.get('shopId'))]
            market_ids = row.get('marketplaceIdList') if endpoint == 'product-analysis/v2' else [str(row.get('marketplaceId'))]
            if shop is not None and shop_ids != [shop]:
                raise ValueError(f'{endpoint}: cross-shop or missing shopId: {row.get("shopId")}')
            if marketplace is not None and market_ids != [marketplace]:
                raise ValueError(f'{endpoint}: cross-marketplace or missing marketplaceId: {row.get("marketplaceId")}')
        result.extend(rows)
        print(f'{endpoint} page={page}/{count} rows={len(result)}/{total}', flush=True)
        if page >= count:
            return result
        page += 1


def quantity(value):
    if value is None or value == '':
        return None
    if isinstance(value, bool):
        raise ValueError('Boolean quantity')
    number = Decimal(str(value))
    if not number.is_finite() or number < 0:
        raise ValueError(f'Invalid quantity: {value!r}')
    return number


def keyed(rows, fields):
    unique, conflicts, duplicates = {}, {}, 0
    for row in rows:
        key = tuple(str(row.get(f) or '').strip() for f in fields)
        if key not in unique:
            unique[key] = row
        elif unique[key] == row:
            duplicates += 1
        else:
            conflicts.setdefault(key, [unique[key]]).append(row)
    return unique, conflicts, duplicates


def install_snapshot_auth(state_path):
    """Read existing browser state in memory; no DB access or auth refresh."""
    from types import SimpleNamespace
    from services.mabang.amazon.fba import store_msku, store_msku_actual_inventory as inventory
    from services.mabang.amazon.fba import unlinked_shipments, batch_delivery
    from services.mabang.cookies import build_cookie_header
    state = json.loads(state_path.read_text())
    grouped = {}
    for cookie in state['cookies']:
        grouped.setdefault(cookie['domain'], []).append(cookie)
    async def context(**kwargs):
        return SimpleNamespace(cookies_by_domain=grouped)
    async def warehouse_cookie():
        return build_cookie_header(grouped, 'private-amz.mabangerp.com')
    async def token(**kwargs):
        tokens = [x['value'] for origin in state['origins'] for x in origin.get('localStorage',[]) if x['name'] == 'freeToken']
        if len(set(tokens)) != 1:
            raise ValueError('Expected one unique freeToken in supplied state')
        return tokens[0]
    store_msku.get_auth_context = context
    inventory._resolve_private_amz_cookie = warehouse_cookie
    unlinked_shipments.get_fba_free_token = token
    batch_delivery.get_fba_free_token = token


async def source_excel(output):
    from services.mabang.amazon.fba.store_msku import download_store_msku_excel
    from shared.infra.net import close_all_network_clients
    started = now()
    try:
        result = await download_store_msku_excel('1039477', 'fbaWarehouseIds[]', store_name='Amazon-YYH-US', output_dir=output/'mabang-source')
        save(output/'mabang-source.json', dict(started=started, ended=now(), **result.to_payload()))
    finally:
        await close_all_network_clients()


async def fixed_mabang(client, output):
    import asyncio
    from dataclasses import asdict
    from services.mabang.amazon.fba import combo_sku, store_msku_actual_inventory as inventory, unlinked_shipments
    from shared.infra.net import close_all_network_clients
    async def recorded(endpoint, body, **kwargs):
        return await asyncio.to_thread(client.post, 'mabang', endpoint, body)
    # Recorded transport is serialized to keep request ledger ordering deterministic.
    lock = asyncio.Lock()
    async def serialized(endpoint, body, **kwargs):
        async with lock:
            return await recorded(endpoint, body, **kwargs)
    combo_sku.post_json = serialized
    try:
        if (output/'mabang-bindings.json').exists():
            bindings = [combo_sku.ListingSkuBinding(**x) for x in json.loads((output/'mabang-bindings.json').read_text())]
        else:
            bindings = await combo_sku.fetch_listing_bindings('Amazon-YYH-US')
        save(output/'mabang-bindings.json', [asdict(x) for x in bindings])
        if (output/'mabang-combos.json').exists():
            combos = {k:combo_sku.ComboSku(v['combo_sku'],tuple(combo_sku.ComboComponent(c['stock_sku'],Decimal(c['quantity'])) for c in v['components'])) for k,v in json.loads((output/'mabang-combos.json').read_text()).items()}
        else:
            combos = await combo_sku.fetch_combo_sku_map(sorted({x.local_sku for x in bindings if x.stock_type == 2}))
        save(output/'mabang-combos.json', {k:asdict(v) for k,v in combos.items()})
        skus = inventory.stock_skus_for_inventory(sorted({x.local_sku for x in bindings if x.local_sku}), combos)
        if not (output/'warehouse.json').exists():
            started = now()
            await inventory.search_warehouse_stock(skus)
            path = await inventory.download_warehouse_stock_xlsx(output_dir=output/'fixed', store_name='Amazon-YYH-US')
            save(output/'warehouse.json', dict(started=started, ended=now(), path=str(path), stock=inventory.parse_stock_inventory_xlsx(path)))
        if not (output/'unlinked.json').exists():
            started = now()
            result = await unlinked_shipments.download_store_unlinked_shipments('Amazon-YYH-US', output_dir=output/'unlinked-raw')
            save(output/'unlinked.json', dict(started=started, ended=now(), **result.to_payload()))
    finally:
        await close_all_network_clients()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--probe', action='store_true')
    parser.add_argument('--auth-state', type=Path)
    parser.add_argument('--resume-fixed', action='store_true', help='Resume only missing fixed Mabang stages using existing captured inputs')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=args.resume_fixed)
    load_env(args.env_file)
    client = Client(args.output)
    if args.resume_fixed:
        import asyncio
        if not args.auth_state:
            raise ValueError('--resume-fixed requires --auth-state')
        install_snapshot_auth(args.auth_state)
        asyncio.run(fixed_mabang(client,args.output))
        return
    if args.auth_state and not args.probe:
        import asyncio
        install_snapshot_auth(args.auth_state)
        asyncio.run(source_excel(args.output))
    shops = pages(client, 'shops/normalized', {'pageSize':'100'})
    save(args.output / 'saihu-shops.json', shops)
    matches = [s for s in shops if s['name'] == 'YYH-US' and s['marketplaceId'] == 'ATVPDKIKX0DER']
    if len(matches) != 1:
        raise ValueError(f'Expected unique YYH-US shop, got {len(matches)}')
    shop = matches[0]
    save(args.output / 'shop-candidate.json', shop)
    mb = client.post('mabang', 'shops/list', {})
    save(args.output / 'mabang-shops.json', mb)
    endpoints = {
        'online-products/v2': {'shopIdList':[shop['id']], 'marketplaceIdList':[shop['marketplaceId']]},
        'product-analysis/v2': {'shopIdList':[shop['id']], 'marketplaceIdList':[shop['marketplaceId']], 'dimType':'3', 'subType':'0', 'isNewOrMovingOrInStock':'5', 'startDate':'2026-09-04', 'endDate':'2026-09-04', 'fields':['msku','asin','parentAsin','sevenSaleNum','fourteenSaleNum','thirtySaleNum','ninetySaleNum']},
        'fba/inventory-details': {'shopIdList':[shop['id']], 'hideZero':'false', 'hideDeletedPrd':'false', 'needMergeShare':'false'},
    }
    for endpoint, body in endpoints.items():
        body['pageSize'] = '2' if args.probe else '100'
        if args.probe:
            result = client.post('saihu', endpoint, dict(body,pageNo='1'))
            print(endpoint, client.error_text(result))
        else:
            result = pages(client, endpoint, body, shop=shop['id'], marketplace=shop['marketplaceId'])
        save(args.output / (endpoint.replace('/','_')+'.json'), result)
    if args.auth_state and not args.probe:
        asyncio.run(fixed_mabang(client, args.output))


if __name__ == '__main__':
    main()

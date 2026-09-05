from __future__ import annotations

import asyncio
import json
import hashlib
import re
import sys
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Protocol, Sequence

from services.mabang.official_api import OfficialApiError, diagnostic, invalid, post_json

OFFICIAL_LOOKUP_TIMEOUT_SECONDS = 25 * 60
COMBO_WORKERS = 4


def clean_text(value: Any) -> str:
    text = str(value or "").strip()
    return "" if text.lower() == "nan" else text


def normalize_sku_key(value: Any) -> str:
    return re.sub(r"\s+", "", clean_text(value))


@dataclass(frozen=True)
class ComboComponent:
    stock_sku: str
    quantity: Decimal


@dataclass(frozen=True)
class ComboSku:
    combo_sku: str
    components: tuple[ComboComponent, ...]


@dataclass(frozen=True)
class ListingSkuBinding:
    msku: str
    asin: str
    local_sku: str
    stock_type: int


class SourceRow(Protocol):
    msku: str
    asin: str
    local_sku: str


def _integer(value: Any, context: str, payload: Any, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not re.fullmatch(r"\d+", str(value)) or int(value) < minimum:
        invalid(context, f"无效整数: {value!r}", payload)
    return int(value)


def _site(value: Any) -> str:
    site = clean_text(value).lower()
    return "gb" if site == "uk" else site


def _progress(message: str) -> None:
    print(diagnostic(message), file=sys.stderr, flush=True)


async def fetch_listing_bindings(store_name: str) -> list[ListingSkuBinding]:
    context = f"Listing 店铺={store_name}"
    shops = await post_json("shops/list", {}, context=context)
    data = shops.get("data")
    if not isinstance(data, dict):
        invalid(context, "店铺 data 必须为对象", shops)
    matches = [row for row in data.values() if isinstance(row, dict) and clean_text(row.get("name")) == store_name.strip()]
    if len(matches) != 1:
        invalid(context, f"店铺精确匹配数量={len(matches)}，需要唯一匹配", shops)
    shop = matches[0]
    # Verified against production: the object key/profile_id does NOT filter listings.
    # sid filters shopIds correctly; see the captured contract fixture and report.
    shop_id = str(_integer(shop.get("sid"), context, shop, minimum=1))
    site = _site(shop.get("amazonsite"))
    if not site:
        invalid(context, "店铺缺少站点", shop)
    bindings: list[ListingSkuBinding] = []
    total: int | None = None
    pages: int | None = None
    seen: set[str] = set()
    count = 0
    page = 1
    while True:
        page_context = f"{context} sid={shop_id} 站点={site} page={page}"
        payload = await post_json("listings/search", {
            "shop_id": [shop_id], "amazonsite": [site], "page": str(page), "pageSize": "1000",
        }, context=page_context)
        data = payload.get("data")
        if not isinstance(data, dict) or not isinstance(data.get("list"), list):
            invalid(page_context, "缺少 data.list", payload)
        current_total = _integer(data.get("total"), page_context, payload)
        current_pages = _integer(data.get("totalPage"), page_context, payload)
        current_page = _integer(data.get("nowPage"), page_context, payload, minimum=1)
        if total is None:
            total, pages = current_total, current_pages
        if current_total != total or current_pages != pages or current_page != page or pages != max(1, (total + 999) // 1000):
            # Empty listing queries in production may report zero total pages.
            if not (page == 1 and total == current_total == 0 and current_pages == pages == 0 and current_page == 1):
                invalid(page_context, "分页数量矛盾或查询期间发生变化", payload)
        records = data["list"]
        if len(records) != min(1000, total - count):
            invalid(page_context, "分页记录数与 total 不一致", payload)
        fingerprint = hashlib.sha256(json.dumps(records, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        if fingerprint in seen:
            invalid(page_context, "重复分页", payload)
        seen.add(fingerprint)
        for row in records:
            if not isinstance(row, dict):
                invalid(page_context, "Listing 不是对象", row)
            # Real responses contain comma-wrapped shopIds and empty shopList.
            row_shops = {s.strip() for s in clean_text(row.get("shopIds")).split(",") if s.strip()}
            if shop_id not in row_shops or _site(row.get("amazonsite")) != site:
                invalid(page_context, "返回了其他店铺或站点的 Listing", row)
            local_sku = clean_text(row.get("stockSku"))
            stock_type = _integer(row.get("stockType"), page_context, row, minimum=1)
            if stock_type not in (1, 2) or not clean_text(row.get("platformSku")):
                invalid(page_context, "无效 stockType 或缺少 MSKU", row)
            bindings.append(ListingSkuBinding(clean_text(row["platformSku"]), clean_text(row.get("asin")), local_sku, stock_type))
        count += len(records)
        _progress(f"{context}: Listing {count}/{total}，page={page}/{pages}")
        if count == total:
            return bindings
        page += 1


def select_combo_skus(rows: Sequence[SourceRow], bindings: Sequence[ListingSkuBinding]) -> list[str]:
    by_msku: dict[str, list[ListingSkuBinding]] = {}
    for binding in bindings:
        by_msku.setdefault(normalize_sku_key(binding.msku), []).append(binding)
    types: dict[str, int] = {}
    combos: dict[str, str] = {}
    for row in rows:
        local_key = normalize_sku_key(row.local_sku)
        if not local_key:
            continue
        candidates = by_msku.get(normalize_sku_key(row.msku), [])
        if clean_text(row.asin):
            candidates = [item for item in candidates if item.asin == clean_text(row.asin)]
        definitions = {(normalize_sku_key(item.local_sku), item.stock_type) for item in candidates}
        context = f"Listing 匹配 MSKU={row.msku} ASIN={row.asin} 本地SKU={row.local_sku}"
        if len(definitions) != 1:
            invalid(context, "未匹配或绑定存在歧义", [vars(item) for item in candidates])
        binding_sku, stock_type = next(iter(definitions))
        if binding_sku != local_key or stock_type not in (1, 2):
            invalid(context, "本地 SKU 绑定变化或类型无效", [vars(item) for item in candidates])
        if local_key in types and types[local_key] != stock_type:
            invalid(context, "同一本地 SKU 类型冲突", {"previous": types[local_key], "current": stock_type})
        types[local_key] = stock_type
        if stock_type == 2:
            combos.setdefault(local_key, row.local_sku)
    _progress(f"Listing 匹配完成: 本地SKU={len(types)}，普通={len(types)-len(combos)}，组合={len(combos)}")
    return list(combos.values())


def _parse_combo(row: dict[str, Any], context: str) -> ComboSku:
    details = row.get("comboProductDetail")
    if not isinstance(details, list) or not details:
        invalid(context, "组合组件为空或格式无效", row)
    components: list[ComboComponent] = []
    seen: set[str] = set()
    for item in details:
        if not isinstance(item, dict):
            invalid(context, "组合组件不是对象", row)
        sku = clean_text(item.get("stockSku"))
        key = normalize_sku_key(sku)
        try:
            quantity = Decimal(str(item.get("quantity")))
        except InvalidOperation:
            invalid(context, "无效捆绑数量", item)
        if not key or key in seen or not quantity.is_finite() or quantity <= 0:
            invalid(context, "子SKU缺失/重复或捆绑数量无效", item)
        seen.add(key)
        components.append(ComboComponent(sku, quantity))
    return ComboSku(clean_text(row["comboSku"]), tuple(components))


async def _fetch_combo(sku: str) -> ComboSku:
    count = 0
    total: int | None = None
    page = 1
    seen: set[str] = set()
    found: ComboSku | None = None
    while True:
        context = f"组合SKU={sku} page={page}"
        payload = await post_json("combo-skus/search", {
            "comboSku": sku, "page": page, "rowsPerPage": 20, "showCost": 0,
        }, context=context)
        data = payload.get("data")
        if not isinstance(data, dict) or not isinstance(data.get("data"), list):
            invalid(context, "缺少 data.data", payload)
        current_total = _integer(data.get("total"), context, payload)
        if total is None:
            total = current_total
        if (_integer(data.get("page"), context, payload, minimum=1) != page
                or _integer(data.get("rowsPerPage"), context, payload, minimum=1) != 20
                or current_total != total):
            invalid(context, "分页矛盾或查询期间发生变化", payload)
        records = data["data"]
        if len(records) != min(20, total-count):
            invalid(context, "分页记录数与 total 不一致", payload)
        fingerprint = hashlib.sha256(json.dumps(records, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        if fingerprint in seen:
            invalid(context, "重复分页", payload)
        seen.add(fingerprint)
        for row in records:
            if not isinstance(row, dict) or not clean_text(row.get("comboSku")):
                invalid(context, "组合记录缺少 comboSku", row)
            if normalize_sku_key(row["comboSku"]) != normalize_sku_key(sku):
                continue
            combo = _parse_combo(row, context)
            if found is not None and found != combo:
                invalid(context, "同名组合定义冲突", row)
            found = combo
        count += len(records)
        if count == total:
            if found is None:
                invalid(context, "Listing 已标记为组合 SKU，但未找到精确匹配的组合明细", payload)
            return found
        page += 1


async def fetch_combo_sku_map(combo_skus: list[str]) -> dict[str, ComboSku]:
    skus = list({normalize_sku_key(sku): clean_text(sku) for sku in combo_skus if normalize_sku_key(sku)}.values())
    pending = iter(skus)
    results: dict[str, ComboSku] = {}

    async def worker() -> None:
        for sku in pending:
            results[normalize_sku_key(sku)] = await _fetch_combo(sku)
            _progress(f"组合明细 {len(results)}/{len(skus)}")

    tasks = [asyncio.create_task(worker()) for _ in range(min(COMBO_WORKERS, len(skus)))]
    try:
        await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    return {normalize_sku_key(sku): results[normalize_sku_key(sku)] for sku in skus}


async def fetch_inventory_combos(store_name: str, rows: Sequence[SourceRow]) -> dict[str, ComboSku]:
    if not any(normalize_sku_key(row.local_sku) for row in rows):
        return {}
    try:
        async with asyncio.timeout(OFFICIAL_LOOKUP_TIMEOUT_SECONDS):
            bindings = await fetch_listing_bindings(store_name)
            return await fetch_combo_sku_map(select_combo_skus(rows, bindings))
    except TimeoutError as exc:
        raise OfficialApiError(f"店铺={store_name}", f"官方查询超过 {OFFICIAL_LOOKUP_TIMEOUT_SECONDS} 秒") from exc

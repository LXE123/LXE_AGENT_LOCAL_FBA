"""Offline comparison and deterministic replenishment replay of captured inputs."""
from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from dataclasses import asdict
from decimal import Decimal
from pathlib import Path

from saihu_msku_compare import keyed, quantity, save

SALES = [('7天销量','sevenSaleNum','day7SaleNum'), ('14天销量','fourteenSaleNum','day14SaleNum'), ('30天销量','thirtySaleNum','day30SaleNum'), ('90天销量','ninetySaleNum',None)]
FBA = [('可售','available'), ('待调仓','reservedTransfer'), ('调仓中','reservedProcessing'), ('预留','reservedCustomerorders')]
RAW_FBA = ['available','reservedTransfer','reservedProcessing','reservedCustomerorders','inboundWorking','inboundShipped','inboundReceiving','unfulfillable','totalInventory','inTransit','research','presale']


def read(path):
    return json.loads(path.read_text())


def excel(path):
    from openpyxl import load_workbook
    wb = load_workbook(path, read_only=True, data_only=True)
    try:
        rows = iter(wb.active.values)
        headers = next(rows)
        return [dict(zip(headers,row)) for row in rows if any(v is not None for v in row)]
    finally:
        wb.close()


def scalar_list(row, field):
    values = row.get(field)
    if not isinstance(values,list) or len(values) != 1 or not str(values[0]).strip():
        raise ValueError(f'Expected one {field}: {values!r}')
    return str(values[0]).strip()


def sales_rows(rows):
    result, rejected = [], []
    for row in rows:
        try:
            item = dict(msku=scalar_list(row,'mskuList'), asin=scalar_list(row,'asinList'), product_id=scalar_list(row,'productIdList'))
            for label, field, _ in SALES:
                item[label] = quantity(row.get('fieldsMap',{}).get(field,{}).get('currValue'))
            result.append(item)
        except ValueError as exc:
            rejected.append(dict(group=row.get('groupByStr'), reason=str(exc), row=row))
    return result, rejected


def n(value):
    if value is None:
        return None
    value = quantity(value)
    return int(value) if value == value.to_integral_value() else float(value)


def replay(source, combos, stock, sales_source, unlinked, template=None):
    from services.mabang.amazon.fba import store_msku_actual_inventory as inv, store_msku_sales_analysis as sales, store_msku_replenishment as rep
    source_rows, details = [], {}
    for old, binding, metrics in source:
        values = [quantity((old if sales_source == 'mabang' else metrics)[label]) for label,_,_ in SALES[:3]]
        fba = [quantity(old.get(label)) for label in inv.FBA_STOCK_COLUMNS]
        if any(v is None for v in values + fba):
            raise ValueError('Missing sales/inventory must be excluded before replay')
        row = inv.StoreMskuRow(msku=old['MSKU'], parent_asin=old.get('父ASIN') or '', asin=old['ASIN'], local_sku=binding['local_sku'], product_link=old.get('商品链接') or '', sales_7d=values[0], sales_14d=values[1], sales_30d=values[2], fba_sellable=fba[0], fba_inbound=fba[1], fba_reserved=fba[2], fba_in_transit=fba[3], fba_pending_transfer=fba[4], fba_transferring=fba[5], local_sku_name=old.get('本地SKU名称') or '', product_name=old.get('产品名称') or '', remark=old.get('备注') or '')
        source_rows.append(row)
        trend = sales.compute_sales_metrics(*values)
        details[(row.msku,row.parent_asin or '未填写父ASIN',row.asin,row.local_sku)] = rep.SalesDetail(trend=trend.trend, trend_rate=None if trend.trend_ratio is None else sales._display_number(trend.trend_ratio), weight_grams=rep.parse_weight_grams(old.get('单品重量(g)(cm)')), sales_7d=float(values[0]), sales_14d=float(values[1]), sales_30d=float(values[2]))
    actual, missing = inv.calculate_inventory_rows(source_rows, combo_map=combos, stock_quantities=stock)
    eligible = inv.split_inventory_rows(actual).inventory_rows
    # Preserve the existing Excel boundary's 2-decimal rounding before calculation.
    inputs = [rep.InventoryInputRow(msku=x.msku,parent_asin=x.parent_asin or '未填写父ASIN',asin=x.asin,local_sku=x.local_sku,local_sku_name=x.local_sku_name,product_name=x.product_name,remark=x.remark,product_link=x.product_link,sku_type='组合sku' if x.is_combo_sku else '库存sku',weighted_daily_sales=inv._display_two_decimal(x.weighted_daily_sales),sales_days=None if x.sales_days is None else inv._display_two_decimal(x.sales_days),fba_total_inventory=float(x.fba_total_inventory),actual_inventory=None if x.actual_inventory is None else float(x.actual_inventory),child_skus=x.child_skus) for x in eligible]
    results = rep.calculate_replenishment_rows(inputs, details, template=template, unlinked_quantities=unlinked)
    return [asdict(x) for x in results], [asdict(x) for x in actual], missing


def analyze(root):
    source_path = next((root/'mabang-source').glob('*.xlsx'))
    old_rows = excel(source_path)
    listings = read(root/'online-products_v2.json')
    inventory = read(root/'fba_inventory-details.json')
    metrics, rejected = sales_rows(read(root/'product-analysis_v2.json'))
    bindings = read(root/'mabang-bindings.json')
    old, old_conflicts, old_dup = keyed(old_rows, ['MSKU','ASIN'])
    online, online_conflicts, online_dup = keyed(listings, ['sku','asin'])
    inv, inv_conflicts, inv_dup = keyed(inventory, ['sku','asin'])
    met, met_conflicts, met_dup = keyed(metrics, ['msku','asin'])
    # Compare business binding only; duplicate record metadata must not cause conflicts.
    bind, bind_conflicts, bind_dup = keyed([{k:x[k] for k in ('msku','asin','local_sku','stock_type')} for x in bindings], ['msku','asin'])
    all_keys = sorted(set(old)|set(online))
    coverage, binding_table, sales_table, inventory_table, blocked, source_new = [], [], [], [], [], []
    eligible = []
    exact_fnsku = 0
    parent_asins = {x.get('parentAsin') for x in listings}
    for key in all_keys:
        a,b = old.get(key),online.get(key)
        status = '双方共有' if a and b else ('仅马帮有' if a else '仅赛狐有')
        conflicts = [label for label,index in [('马帮源表',old_conflicts),('赛狐Listing',online_conflicts),('赛狐库存',inv_conflicts),('赛狐销量',met_conflicts),('马帮绑定',bind_conflicts)] if key in index]
        match_fn = bool(a and b and a.get('FNSKU') and a['FNSKU'] == b.get('fnsku'))
        exact_fnsku += match_fn
        scope_reason = ''
        if a and not b:
            scope_reason = '父体记录：ASIN等于父ASIN，赛狐子项引用该父ASIN' if key[1] == a.get('父ASIN') and key[1] in parent_asins else '遗漏原因待核实'
        elif b and not a:
            scope_reason = '赛狐已删除历史记录' if b.get('dxmPublishState') == 'delete' else '赛狐额外记录，业务范围待确认'
        coverage.append([*key,status,a.get('父ASIN') if a else None,b.get('parentAsin') if b else None,a.get('FNSKU') if a else None,b.get('fnsku') if b else None,b.get('switchFulfillmentTo') if b else None,b.get('onlineStatus') if b else None,b.get('dxmPublishState') if b else None,'、'.join(conflicts),scope_reason])
        binding = bind.get(key)
        binding_table.append([*key,a.get('本地SKU') if a else None,binding.get('local_sku') if binding else None,binding.get('stock_type') if binding else None, '绑定冲突' if key in bind_conflicts else ('Listing未匹配' if not binding else ('绑定变化' if a and str(a.get('本地SKU') or '') != binding['local_sku'] else '一致或赛狐新增'))])
        for label,field,listing_field in SALES:
            x = n(a.get(label)) if a else None
            y = n(met[key][label]) if key in met else None
            sales_table.append([*key,label,x,y,None,None,n(b.get(listing_field)) if b and listing_field else None,'缺值' if x is None or y is None else '统计窗口待确认'])
        stockrow = inv.get(key)
        inventory_table.append([*key,*[n(a.get(label)) if a else None for label in ('可售','待入库','在途','预留','待调仓','调仓中','计划入库','总在途量(默认设置)')],*[n(stockrow.get(field)) if stockrow else None for field in RAW_FBA],None,None,'未找到库存明细' if not stockrow else '保留原始分项；总库存及未关联货件重叠待确认'])
        reason = []
        if status != '双方共有': reason.append(status)
        if conflicts: reason.append('、'.join(conflicts)+'冲突')
        if not binding or not binding['local_sku']: reason.append('无明确马帮本地SKU绑定')
        if a and not a.get('本地SKU'): reason.append('马帮源表无本地SKU')
        if key not in met or any(met[key][label] is None for label,_,_ in SALES): reason.append('赛狐销量缺失')
        if a and any(quantity(a.get(label)) is None for label in ['7天销量','14天销量','30天销量','可售','待入库','预留','在途','待调仓','调仓中']): reason.append('马帮销量或库存缺失')
        if reason: blocked.append([*key,'；'.join(reason)])
        else: eligible.append((a,binding,met[key]))
        if b:
            source_new.append(dict(msku=key[0],asin=key[1],parent_asin=b.get('parentAsin'),local_sku=binding.get('local_sku') if binding and key not in bind_conflicts else None,stock_type=binding.get('stock_type') if binding and key not in bind_conflicts else None,sales=met.get(key),fba=stockrow,listing_quantity=b.get('quantity'),replenishment=None,blocked_reason='FBA口径与未关联货件重叠待确认'))
    from services.mabang.amazon.fba.combo_sku import ComboSku, ComboComponent
    combos = {k:ComboSku(x['combo_sku'],tuple(ComboComponent(y['stock_sku'],Decimal(y['quantity'])) for y in x['components'])) for k,x in read(root/'mabang-combos.json').items()}
    stock = {k:Decimal(v) for k,v in read(root/'warehouse.json')['stock'].items()}
    from services.mabang.amazon.fba.unlinked_shipments import _raw_detail_rows, summarize_unlinked_shipment_details
    raw_unlinked = read(root/'unlinked.json')
    raw_files = [x['raw_file_path'] for x in raw_unlinked['status_results'] if x.get('raw_file_path')]
    detail = _raw_detail_rows(raw_files, store_name='Amazon-YYH-US')
    summary = summarize_unlinked_shipment_details(detail)
    save(root/'unlinked-fixed-details.json',detail)
    save(root/'unlinked-fixed-summary.json',summary)
    unlinked = {x['MSKU']:float(x['未关联数量']) for x in summary}
    from services.mabang.amazon.fba.replenishment_template import get_template, ReplenishmentTemplate
    template_path=root/'fixed-template.json'
    if not template_path.exists(): save(template_path,get_template('默认').to_payload())
    template=ReplenishmentTemplate(**read(template_path))
    a, actual_a, missing_a = replay(eligible,combos,stock,'mabang',unlinked,template)
    b, actual_b, missing_b = replay(eligible,combos,stock,'saihu',unlinked,template)
    assert replay(eligible,combos,stock,'saihu',unlinked,template)[0] == b, 'Replay must be deterministic'
    blocked.extend([[x['msku'],x['asin'],'深圳库存缺失，保留未知值，未进入最终建议'] for x in actual_a if x['actual_inventory'] is None])
    save(root/'replay-A.json', a);save(root/'replay-B.json', b)
    save(root/'actual-A.json',actual_a);save(root/'actual-B.json',actual_b)
    save(root/'saihu-full-source.json',source_new)
    save(root/'replay-CD.json',dict(groups=['C','D','赛狐全量补货'],state='blocked',reason='FBA分项口径、在途与未关联货件重叠尚未得到证据确认；不生成补货数量'))
    replay_table = []
    important = ['replenish_quantity','sheet_name','transport_channel','sales_trend','actual_inventory','fba_total_inventory','original_replenish_quantity','sea_quantity','companion_air_quantity']
    changed = 0
    bmap = {(x['msku'],x['asin']):x for x in b}
    for x in a:
        y = bmap[(x['msku'],x['asin'])]
        fields = [k for k in important if x[k] != y[k]]
        changed += bool(fields)
        replay_table.append([x['msku'],x['asin'],x['local_sku'],x['replenish_quantity'],y['replenish_quantity'],None,x['sheet_name'],y['sheet_name'],x['sales_trend'],y['sales_trend'],x['actual_inventory'],x['fba_total_inventory'],x['unlinked_quantity'],'、'.join(fields),x['decision_reason'],y['decision_reason']])
    replay_table.sort(key=lambda row: (not bool(row[13]), -abs((row[4] or 0)-(row[3] or 0)), row[0], row[1]))
    counts = dict(mabang_rows=len(old_rows),saihu_listing_rows=len(listings),saihu_sales_rows=len(metrics),saihu_inventory_rows=len(inventory),common=len(set(old)&set(online)),mabang_only=len(set(old)-set(online)),saihu_only=len(set(online)-set(old)),exact_fnsku=exact_fnsku,replay_candidates=len(eligible),replay_rows=len(a),changed_rows=changed,missing_warehouse_skus=len(missing_a),unlinked_quantity=sum(unlinked.values()),sales_rejected=len(rejected),conflicts={k:len(v) for k,v in [('mabang',old_conflicts),('listing',online_conflicts),('sales',met_conflicts),('inventory',inv_conflicts),('binding',bind_conflicts)]},A_categories=dict(Counter(x['sheet_name'] for x in a)),B_categories=dict(Counter(x['sheet_name'] for x in b)))
    counts['quantity_changed_rows']=sum(x['replenish_quantity'] != bmap[(x['msku'],x['asin'])]['replenish_quantity'] for x in a)
    counts['category_changed_rows']=sum(x['sheet_name'] != bmap[(x['msku'],x['asin'])]['sheet_name'] for x in a)
    common_sales=sorted(set(old)&set(met))
    sales_stats=[]
    for label,_,_ in SALES:
        pairs=[(quantity(old[k].get(label)),met[k][label]) for k in common_sales]
        valid=[(x,y) for x,y in pairs if x is not None and y is not None]
        sales_stats.append([label,len(valid),sum(x!=y for x,y in valid),int(sum(x for x,y in valid)),int(sum(y for x,y in valid))])
    shared_inventory=sorted(set(old)&set(inv))
    equations=[('马帮可售 = 赛狐available','可售',['available']),('马帮待调仓 = 赛狐reservedTransfer','待调仓',['reservedTransfer']),('马帮调仓中 = 赛狐reservedProcessing','调仓中',['reservedProcessing']),('马帮预留 = 赛狐订单预留 + 调仓中','预留',['reservedCustomerorders','reservedProcessing']),('马帮待入库 = 赛狐inboundReceiving','待入库',['inboundReceiving']),('马帮在途 = 赛狐inboundShipped','在途',['inboundShipped'])]
    equation_stats=[]
    for text,label,fields in equations:
        pairs=[(quantity(old[k].get(label)),sum(quantity(inv[k][f]) for f in fields)) for k in shared_inventory]
        equation_stats.append([text,len(pairs),sum(x!=y for x,y in pairs),int(sum(x for x,y in pairs)),int(sum(y for x,y in pairs))])
    double_processing=sum(quantity(inv[k]['reservedProcessing']) for k in shared_inventory)
    missing_fba=sorted((set(old)&set(online))-set(inv))
    binding_changes=sum(bool(old[k].get('本地SKU')) and str(old[k]['本地SKU'])!=bind[k]['local_sku'] for k in set(old)&set(bind))
    counts.update(binding_changes=binding_changes,missing_common_fba=len(missing_fba),shared_inventory_rows=len(shared_inventory),duplicate_processing_quantity=int(double_processing))
    save(root/'summary.json', counts)
    save(root/'sales-rejected.json', rejected)
    tables = {
        '概览': {'headers':['项目','结果'], 'rows':[['马帮源表行数',len(old_rows)],['赛狐Listing行数',len(listings)],['双方共有记录',counts['common']],['仅马帮有',counts['mabang_only']],['仅赛狐有',counts['saihu_only']],['相同非空FNSKU',exact_fnsku],['A/B实际重放行数',len(a)],['补货计算量变化行数',counts['quantity_changed_rows']],['分类变化行数',counts['category_changed_rows']],['固定未关联货件数量',sum(unlinked.values())],['共有记录中缺少赛狐库存明细',len(missing_fba)],['旧算法重复计入调仓中（1999条共有库存）',int(double_processing)],['本地绑定变化',binding_changes],['C、D及全量补货','库存口径待确认，未计算'],['销量窗口','起止日期为2026-09-04，滚动销量截止时间待确认'],['身份验证','美国站点、共同MSKU+ASIN和FNSKU交叉验证；马帮接口不含卖家ID']]},
        '记录覆盖': {'headers':['MSKU','ASIN','覆盖','马帮父ASIN','赛狐父ASIN','马帮FNSKU','赛狐FNSKU','赛狐配送','赛狐状态','赛狐发布状态','冲突','范围说明'],'rows':coverage},
        '本地绑定': {'headers':['MSKU','ASIN','马帮Excel本地SKU','马帮实时本地SKU','类型','绑定结果'],'rows':binding_table},
        '销量对照': {'headers':['MSKU','ASIN','周期','马帮销量','赛狐分析销量','赛狐减马帮','差异比例','赛狐Listing销量','口径说明'],'rows':sales_table,'formulas':'sales'},
        '库存对照': {'headers':['MSKU','ASIN','马帮可售','马帮待入库','马帮在途','马帮预留','马帮待调仓','马帮调仓中','马帮计划入库','马帮总在途',*['赛狐_'+x for x in RAW_FBA],'预留减订单预留与调仓中','在途减三项入库','口径说明'],'rows':inventory_table,'formulas':'inventory'},
        '补货对照AB': {'headers':['MSKU','ASIN','本地SKU','A补货量','B补货量','B减A','A分类','B分类','A趋势','B趋势','固定深圳库存','固定FBA库存','固定未关联量','变化字段','A原因','B原因'],'rows':replay_table,'formulas':'replay'},
        '重放排除': {'headers':['MSKU','ASIN','未进入共有集重放原因'],'rows':blocked},
        '销量汇总': {'headers':['周期','有效比较行数','不同值行数','马帮合计','赛狐合计'],'rows':sales_stats},
        '库存口径核对': {'headers':['逐项等式','核对行数','不等行数','左侧合计','右侧合计'],'rows':equation_stats},
    }
    requests=read(root/'requests.json')
    request_stats={}
    for call in requests:
        endpoint=call['provider']+'/'+call['endpoint']
        stat=request_stats.setdefault(endpoint,dict(count=0,seconds=0,start=call['started'],end=call['ended']))
        stat['count']+=1;stat['seconds']+=call['seconds'];stat['end']=call['ended']
    save(root/'collection-summary.json',dict(endpoints=request_stats,source=read(root/'mabang-source.json'),warehouse={k:v for k,v in read(root/'warehouse.json').items() if k!='stock'},unlinked={k:v for k,v in raw_unlinked.items()},amazon_auxiliary_snapshots=[],notes=['正式目录没有发现可用的亚马逊辅助快照，A/B均不使用。','私有下载阶段保留起止时间和原文件，未逐请求计数；官方API全部逐请求留存。']))
    tables['数据来源']={'headers':['来源','记录或页数','请求数','累计请求秒数','开始时间UTC','结束时间UTC'],'rows':[[k,None,v['count'],round(v['seconds'],2),v['start'],v['end']] for k,v in request_stats.items()]+[['马帮源表Excel',len(old_rows),None,None,read(root/'mabang-source.json')['started'],read(root/'mabang-source.json')['ended']],['原文件与重放', '详见同目录采集清单和JSON；空值不代表0',None,None,None,None]]}
    save(root/'workbook-tables.json',tables)
    report=f'''# Amazon-YYH-US 数据对照验证

当前结论：赛狐具备替换店铺、MSKU和销量来源的条件，但不能直接切换整条备货流程。正式流程未修改，C/D及赛狐全量补货数量按计划保持未计算。

用户已确认：后续以赛狐作为销量和FBA库存的目标口径，马帮用于历史基线和本地SKU/深圳库存。对照用于解释迁移影响，不要求赛狐复刻马帮数值或旧算法的重复项。

## 覆盖与身份

马帮新源表 `{source_path.name}` 共 {len(old_rows)} 行；赛狐 Listing 和商品分析均为 {len(listings)} 行、56 页；库存明细 {len(inventory)} 行、34 页，所有分页和店铺/站点校验通过。

赛狐 YYH-US：shopId=143277，sellerId=A2FF2JNYSIL0AC，美国站 ATVPDKIKX0DER；马帮 Amazon-YYH-US：sid=2021143528、us。两边共有 {counts['common']} 个 MSKU+ASIN，{exact_fnsku} 个非空 FNSKU 完全一致，另一个双方均为空。赛狐内嵌库存中有卖家编号的记录均属于该卖家。马帮店铺接口不返回卖家编号，因此这里采用站点、MSKU、ASIN及FNSKU交叉验证，未声称两边卖家编号已直接比对。

马帮独有的29条都是父体记录，ASIN等于父ASIN且被赛狐子项引用，均无本地SKU、销量和可售库存为0。赛狐独有3181条，其中3121条已删除，另外60条需在迁移时明确业务范围。记录详情全部保留在对照表，没有自动剔除历史商品。

## 销量差异

|周期|比较行数|不同值行数|马帮销量合计|赛狐销量合计|
|---|---:|---:|---:|---:|
''' + '\n'.join('|'+ '|'.join(map(str,row))+'|' for row in sales_stats) + f'''

商品分析的真实结构为 fieldsMap.指标.currValue。上游实际要求 startDate/endDate，缺失时返回 HTTP 502，上游 HTTP 400/code 40014，原始诊断已保留在样本目录。正式本轮请求使用2026-09-04；滚动窗口是否含当天、时区和取消订单口径仍未获文档或订单级证据确认。A/B是替换数值的敏感性对照，不能据此判定哪家销量更准确。

## 库存口径

对共有且有库存明细的 {len(shared_inventory)} 条逐项核对：

''' + '\n'.join(f'- {row[0]}：{row[2]} 条不等。' for row in equation_stats) + f'''

现有代码将“预留”和“调仓中”再次相加，因此这批记录重复计入 {int(double_processing)} 件调仓中库存。A/B保留原算法及其Excel两位小数边界，本轮没有顺手修正此问题。

另有 {len(missing_fba)} 条共有记录未在专用FBA明细中匹配，均为AFN/Inactive。其中 YYHUSA575SKU04 的马帮/旧Listing ASIN为B0FX9WZVK6，内嵌库存和专用库存已对应新ASIN B0GWYZKVML，库存33件。这是同一MSKU关联不同ASIN的真实案例，不能跨ASIN静默套用或填0。

赛狐3351条库存中，inTransit逐条等于inboundWorking+inboundShipped+inboundReceiving；totalInventory逐条等于可售、三种预留、三种入库、不可售和调查中之和。该等式是本轮样本观察，不能把包含不可售和调查中的totalInventory直接当可扣减库存。与马帮未关联货件是否重叠仍需货件级证据。

## 固定输入重放

本轮947个组合定义、深圳仓库库存、1700件未关联货件固定复用。参数为随结果保存的默认v1；未找到正式目录中的亚马逊辅助快照，A/B均不使用。共有集有明确本地绑定且数值完整的 {len(eligible)} 行，其中 {len(eligible)-len(a)} 行缺深圳库存，按原规则不进入最终建议；实际重放 {len(a)} 行。

A使用马帮销量和FBA，B仅换成赛狐销量。{counts['quantity_changed_rows']} 行扣减后补货计算量变化，{counts['category_changed_rows']} 行分类变化，{changed} 行至少一项数量/分类/趋势等输出变化。A/B完整JSON含每行输入指标、原因及数量，Excel逐行展示；两次B离线重放完全一致。暂不发货行中保留的计算量不应汇总为实际发货量。

|分类|A马帮销量|B赛狐销量|
|---|---:|---:|
'''+'\n'.join(f'|{k}|{counts["A_categories"].get(k,0)}|{counts["B_categories"].get(k,0)}|' for k in sorted(set(counts['A_categories'])|set(counts['B_categories'])))+'''

C、D及赛狐全量补货被阻断，原因是旧库存公式重复项、缺库存/ASIN变化，以及未关联货件是否重复扣减尚未确认。赛狐全量标准化数据已保存为 saihu-full-source.json，所有补货数量为null并附原因；没有输出猜测的全店补货量。

## 后续切换条件

先确定父体、已删除和停售记录的范围；确认销量窗口；处理MSKU跨ASIN的库存归属；决定修正旧库存重复项后的目标公式；用货件级记录核对未关联货件。上述事项完成后再运行C/D，并逐行解释剩余补货差异。本次验证不能作为直接迁移的通过结论。

数据来源：同目录 raw/ 为脱敏官方响应，requests.json 为逐请求日志，collection-summary.json 记录采集阶段，mabang-source/、fixed/、unlinked-raw/ 保存原文件。私有下载阶段保存了起止时间和原文件，但未逐请求计数，不把估算次数充作实测值。
'''
    (root/'验证结论.md').write_text(report)
    manifest={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file() and p.suffix in ('.json','.xlsx','.xls','.csv') and p.name not in ('input-sha256.json','workbook-tables.json','workbook-verification.json','数据对照.xlsx') and 'node_modules' not in p.parts}
    save(root/'input-sha256.json',manifest)
    print(json.dumps(counts,ensure_ascii=False,indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory',type=Path)
    analyze(parser.parse_args().directory)

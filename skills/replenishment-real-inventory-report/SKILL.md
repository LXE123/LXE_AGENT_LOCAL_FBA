---
name: replenishment-real-inventory-report
description: 基于本地已下载的马帮 Amazon 店铺 MSKU 数据查询并生成真实库存（深圳仓库）报告。用户要求查看某个店铺 MSKU、本地SKU、组合SKU 或备货分析所需的真实库存（深圳仓库）数量时使用；如果用户只给模糊店铺名，先使用 replenishment-store-resolve 获取规范 store_name。
type: amazon_replenish
commands:
  - lxeskill replenish inventory actual-export
---

## When to Use

- 用户要获取某个马帮 Amazon 店铺 MSKU 对应的真实库存（深圳仓库）数量。
- 用户要在备货分析前补充 `本地SKU` 的库存数据。
- 用户已经下载过店铺 MSKU 数据，需要基于本地最新文件生成真实库存（深圳仓库）报告。

## Hard Rules

- 必须通过 exec 调用 frontmatter commands 中声明的 lxeskill 命令；禁止直接执行对应 Python 业务模块。
- 下方均为真实 shell 命令；简单参数使用 flags，复杂对象写入 JSON 文件后使用 --input-json。
- 先检查 terminal 的 `ok`；成功时读取 `data` 和 `files`，失败时读取 `error.message` 及可选的 `data.context`。

- 只使用固定 CLI：`lxeskill replenish inventory actual-export --store-name "<店铺名>"`
- 不要手动拼接马帮请求。
- 不要手写、复用或转述样例 Cookie/token。
- 不要自动下载店铺 MSKU 数据；本 skill 只分析本地已下载的店铺 MSKU 文件。
- 如果本地没有店铺 MSKU 数据文件，提示用户先运行 `replenishment-msku-download`。
- 如果用户给的是模糊店铺名，先运行 `replenishment-store-resolve`，用解析成功返回的规范 `store_name` 再查询库存。
- 只把最后一条 `type="result"` 记录作为 terminal；业务字段位于 `data`，附件位于 `files`。
- CLI 失败时只转述 terminal 的 `error.message`；需要定位阶段时可读取 `data.context`。

## How to Execute

如果店铺名不确定，先解析店铺：

```text
lxeskill replenish store resolve --store-name "<店铺名>"
```

解析成功后，用规范 `store_name` 查询真实库存（深圳仓库）：

```text
lxeskill replenish inventory actual-export --store-name "<店铺名>"
```

成功时：

```json
{
  "success": true,
  "store_name": "Amazon-Lerxiuer-FR",
  "warehouse_id": "1014318",
  "warehouse_name": "深圳仓库",
  "source_msku_xlsx_path": "artifacts/replenish/store_msku/202605251530-Amazon-Lerxiuer-FR_店铺MSKU数据.xlsx",
  "source_msku_data_time": "202605251530",
  "unique_local_sku_count": 120,
  "detected_combo_sku_count": 8,
  "queried_warehouse_stock_sku_count": 135,
  "matched_warehouse_inventory_msku_row_count": 118,
  "missing_local_sku_msku_row_count": 3,
  "missing_warehouse_inventory_msku_row_count": 2,
  "missing_warehouse_stock_sku_count": 2,
  "missing_warehouse_stock_skus": ["SKU-A", "SKU-B"],
  "shenzhen_warehouse_inventory_report_xlsx_path": "artifacts/replenish/actual_inventory/202605251530-Amazon-Lerxiuer-FR_真实库存（深圳仓库）.xlsx",
  "result_source": "mabang_store_msku_shenzhen_warehouse_inventory"
}
```

失败时：

```json
{
  "success": false,
  "store_name": "Amazon-Lerxiuer-FR",
  "exception": "..."
}
```

## 数据获取

- 保留本地 MSKU Excel 中的销量和绑定。通过官方 Listing 分页识别本地 SKU 类型（1 库存、2 组合），仅对去重组合 SKU 获取子项和捆绑数量。
- 需要桌面端配置 `LXE_DATA_SERVER_URL` 和 `LXE_DATA_SERVER_API_KEY`；深圳仓库查询仍需要马帮登录态。
- 大店铺可能需要较长时间，命令总超时为 30 分钟；进度写入 stderr，以最终 terminal 为准。
- Listing 无匹配、绑定变化或组合明细缺失时停止生成报告，按实际错误处理；不会回退到网页组合导出。源表绑定变化时需重新下载 MSKU 数据后重试。

## Result Handling

- `success=true`：告诉用户真实库存（深圳仓库）报告已生成，并提供 `shenzhen_warehouse_inventory_report_xlsx_path`。
- 这个数据来自马帮深圳仓库库存查询的 `可用库存量`，不是 FBA 库存，也不是 Amazon 后台库存。
- 结果文件固定包含 4 个 sheet：`真实库存（深圳仓库）-组合sku`、`真实库存（深圳仓库）-库存sku`、`无本地SKU`、`无库存数据`。
- `真实库存（深圳仓库）-组合sku` 和 `真实库存（深圳仓库）-库存sku` 包含列：`MSKU`、`父ASIN`、`ASIN`、`本地SKU`、`商品链接`、`FBA总库存`、`加权日销`、`可销售天数`、`真实库存（深圳仓库）数量`、`子SKU`；按 `加权日销` 降序。
- `无本地SKU` 和 `无库存数据` 包含列：`MSKU`、`父ASIN`、`ASIN`、`本地SKU`、`商品链接`、`真实库存（深圳仓库）数量`、`子SKU`。
- `商品链接` 直接复制自源 MSKU 文件；`FBA总库存 = 可售 + 待入库 + 预留 + 在途 + 待调仓 + 调仓中`；`加权日销 = 7天销量 / 7 * 0.6 + 14天销量 / 14 * 0.3 + 30天销量 / 30 * 0.1`。
- `source_msku_xlsx_path` = 源店铺 MSKU 数据文件。
- `source_msku_data_time` = 源店铺 MSKU 数据时间。
- `unique_local_sku_count` = 源 MSKU 中有本地 SKU 的去重本地 SKU 数。
- `detected_combo_sku_count` = 本次识别到的组合 SKU 数。
- `queried_warehouse_stock_sku_count` = 本次实际查询深圳仓库库存的去重库存 SKU 数；普通本地 SKU 按本身计，组合 SKU 会拆成子库存 SKU 后计数。
- `matched_warehouse_inventory_msku_row_count` = 成功得到深圳仓库库存数量的 MSKU 行数。
- `missing_local_sku_msku_row_count` = 源数据没有 `本地SKU`、未参与库存查询的 MSKU 行数。
- `missing_warehouse_inventory_msku_row_count` = 有 `本地SKU` 但没查到深圳仓库库存数量的 MSKU 行数。
- `missing_warehouse_stock_sku_count` = 查不到的库存 SKU 编号数。
- `result_source` = 机器来源标识，正常回复业务用户时不用重点解释。
- `missing_local_sku_msku_row_count > 0`：提醒这些 MSKU 源数据没有 `本地SKU`，没有参与库存查询，详情在 `无本地SKU` sheet。
- `missing_warehouse_inventory_msku_row_count > 0`：提醒这些 MSKU 有 `本地SKU` 但没有查到深圳仓库库存数量，详情在 `无库存数据` sheet。
- `missing_warehouse_stock_sku_count > 0`：明确提醒这些库存 SKU 未查到，相关报告行在 `无库存数据` sheet，`真实库存（深圳仓库）数量` 留空。
- 结果文件是独立 xlsx，文件名前缀使用源 MSKU 数据时间 `source_msku_data_time`，方便后续备货计算和销量分析报告做同源匹配；不会修改店铺 MSKU 源文件或销量分析报告。

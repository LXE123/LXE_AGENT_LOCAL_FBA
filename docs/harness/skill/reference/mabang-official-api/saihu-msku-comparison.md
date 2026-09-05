# Amazon-YYH-US 赛狐源数据对照

这是 2026-09-05 的独立验证工具，不是正式数据源切换。脚本只写显式指定的输出目录，不修改工具目录契约、正式数据集和报表。真实业务样本留在本地输出目录，不提交 Git。

## 本轮结论

- 马帮 Excel 2358 行，赛狐 Listing/销量各 5510 行。共有 2329 条，其中 2328 个非空 FNSKU 一致，另一个双方均为空。
- 马帮独有29条是无本地SKU、无销量和库存的父体；赛狐独有3181条，其中3121条已删除。不能直接用全量赛狐记录替换原参与计算范围。
- 1999条共有库存的可售、待调仓、调仓中、接收中、已发货均逐条一致。马帮“预留”实际等于赛狐订单预留加调仓中，旧算法再加调仓中会重复计入1209件。本轮保留旧算法，未修正生产代码。
- 330条共有AFN停售记录没有对应的赛狐库存明细。`YYHUSA575SKU04` 的Listing旧ASIN与库存新ASIN不同，涉及33件，不能跨ASIN匹配或把缺记录填0。
- A/B固定组合、深圳库存、1700件未关联货件和默认v1参数，共2094行。仅更换销量后160行补货计算量变化、42行分类变化。C/D及赛狐全量补货因口径未确认而不计算。

正式切换前仍需明确商品范围、销量统计窗口、跨ASIN库存归属、目标库存公式，以及未关联货件是否与赛狐在途重叠。样本数值相同只证明本次观察，不代表永久接口语义。

## 使用方式

从领取的 worktree 根运行，使用该 worktree 的独立虚拟环境：

```bash
uv run --frozen python scripts/saihu_msku_compare.py \
  --env-file /path/to/data-server.env \
  --auth-state /path/to/mabang/browser/state.json \
  --output /path/to/isolated-output

uv run --frozen python scripts/analyze_saihu_msku_compare.py /path/to/isolated-output
```

采集器限定本次YYH-US实验，日期为2026-09-04，使用环境文件中的数据服务地址和API key。认证状态只在进程内读取，不复制虚拟环境或读写Agent数据库。`--probe`仅取少量接口样本。`--resume-fixed`只补齐未完成的马帮固定输入阶段，不重新读取赛狐或下载源表；不要用它拼接不同轮次的数据。

赛狐商品分析真实返回 `shopIdList/marketplaceIdList/mskuList/asinList/productIdList`，销量为 `fieldsMap.*.currValue`。日期虽然在代理文档中可选，上游缺失时实际返回40014。分页、行数、店铺/站点和重复页都需校验；不能因为HTTP成功就认为数据完整。

离线分析调用现有库存和备货计算函数，模拟原报表的日销/可销售天数两位小数、趋势四位小数边界，避免绕过Excel后引入额外计算差异。默认参数保存为 `fixed-template.json`，重放始终复用。缺深圳库存的行沿用原分类，不进入最终建议。

`scripts/render_saihu_msku_compare.mjs` 使用 Codex bundled Node 和 `@oai/artifact-tool`，从 `workbook-tables.json` 生成对照表。先通过 workspace dependency loader 获取运行时，将输出目录下的 `node_modules` 链接到其包目录，再用该 Node 执行此脚本并传入输出目录。导出前执行工作簿操作标记；渲染每个Sheet并检查公式错误。不要为此安装或修改仓库依赖。

输出包括脱敏响应、逐请求清单、原Excel/货件文件、固定参数、源数据和A/B重放JSON、输入SHA256、对照Excel及验证结论。私有下载阶段仅记录阶段起止与原文件，未记录逐请求数；报告明确保留该限制，不推测次数。C/D保持null并带阻断原因。

## 测试

```bash
uv run --frozen pytest python/lxeskill_cli/tests/test_saihu_msku_compare.py
```

覆盖分页/空结果/数量变化/重复页、店铺站点隔离、分析数组结构、重复冲突、缺失和无效数量、认证头、限流重试、真实错误脱敏以及固定输入下重放一致。正式CLI与catalog未修改。

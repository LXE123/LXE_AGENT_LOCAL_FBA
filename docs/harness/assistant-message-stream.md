# 模型请求的消息与流事件

`RuntimeProvider.turn()` 每次调用创建一条 `AssistantMessage`。三个协议使用同一个累积器，返回值与 `done.message` 是同一对象。runtime 负责重试，SDK 内置重试关闭，每次重试生成新的本地消息 ID。

## 生命周期

`start → 内容块事件 → done/error`。start 表示本地请求消息创建，尚不代表供应商已接受请求。准备失败和预先取消也产生 start/error。成功返回最终消息；失败通知事件消费者后，仍抛出分类异常供 runtime 判断重试。

文本、思考和工具调用分别产生 start/delta/end。`contentIndex` 在本条消息中稳定，内容数组只追加。`partial` 是共享实时对象，异步消费者应使用事件自身的 delta 和结束载荷；保存某一时刻的快照需要显式复制。正文结束后不可改变，签名允许在请求结束前补齐。最终消息递归冻结。

工具参数草稿仅存在于累积器中，完整 JSON 对象解析成功后才写入 arguments。长度截断可以留下缺少 arguments 的工具块；runtime 仅在 toolUse 终态执行参数完整的调用。后续上下文不回放工具草稿，也不为它补造结果。

## 协议与重放

- Completions 使用工具 index 关联分片，读取 finish reason 和无正文的 usage 尾帧。
- Responses 按 item ID、output index 和 content index 关联内容；done 载荷校正全文，最终 response 补齐签名和 usage。工具 id 保存 call_id，providerItemId 单独保存输出 item ID。
- Anthropic 使用原生 block index，保留 signature 和 redacted thinking。

消息上的 api/provider/model 表示来源。只有匹配的来源才重放不透明签名、供应商 item ID 和 namespace。旧记录可以继续读取，但不会补造来源。既有 Completions reasoning 字段签名仍可读。

持久化及上下文清理保留这些字段。消息仍由 Bun runtime 管理，不新增数据库表或批量迁移历史。

## 消费与诊断

onEvent 按顺序交付；回调失败会记录诊断并停用该回调，不把 UI 故障变成模型重试。即使不提供回调，也经过相同的消息累积路径。

Usage 的 unreported/partial/complete 区分未上报、部分上报、最终上报。请求失败不代表用量为零，runtime 按消息 ID 结算一次。总结调用复用解析器，但继续返回原有 text/usage 结果形状。

桌面仍接收现有 batch。展示块 ID 为 messageId:contentIndex，失败请求的块标记 error，重试创建新块。完整 partial 和推理签名不进入桌面流。

本次不包含 AsyncIterable、deferred、费用计算、完整事件持久化或跨供应商签名转换。

# Gateway ↔ agent-cli JSON-RPC 2.0

Electron Main 中的 Gateway 启动独立的 agent-cli 子进程：

```text
agent-cli serve --input-format stream-json --output-format stream-json
```

`serve` 使用标准 [JSON-RPC 2.0](https://www.jsonrpc.org/specification) 封装，stdin/stdout
仍按 JSONL 分帧：一行一个 JSON 对象或 batch 数组，正文中的换行由 JSON 转义。
stdout 只写协议消息，日志写 stderr。桌面 Renderer ↔ Electron 的 IPC 不变。
独立的单次执行接口 `agent-cli exec` 见 [Agent CLI exec](../harness/runtime/agent_cli_exec.md)。

## 启动握手

`jsonrpc: "2.0"` 表示通信规范版本，业务协议版本单独管理，目前为 **18**。
`initialize.params` 在资源路径、数据目录、工作区和技能权限之外必须携带
`protocol_version: 18`；成功结果在原健康信息之外返回同一字段。

agent-cli 在创建 runtime host 前验证业务版本；Gateway 核对响应后才标记 ready。
版本不匹配立即失败，不自动重启同一不兼容程序。初始化期间复用同一个 Promise，
完成后重复初始化返回当前健康信息；初始化前只允许 `initialize` 与 `shutdown`。
两端随桌面应用一起更新，不接收原来的 `version/command/payload/ok` wire 封装。

## 请求、响应与通知

```json
{"jsonrpc":"2.0","id":"request-1","method":"has_pending_events","params":{"session_id":"session-1"}}
{"jsonrpc":"2.0","id":"request-1","result":{"pending":false}}
{"jsonrpc":"2.0","id":"request-2","error":{"code":-32000,"message":"run not found","data":{"code":"RunUnavailable"}}}
{"jsonrpc":"2.0","method":"session.changed","params":{"thread_id":"session-1","payload":{"changes":["messages"]}}}
```

请求方法沿用原来的 13 个名称：`initialize`、`update_skill_permissions`、
`update_managed_llm_credential`、`run_turn`、`cancel_turn`、`steer_turn`、`ensure_session`、
`append_pending_event`、`has_pending_events`、`resolve_artifact`、`resolve_attachment`、
`dashboard_call`、`shutdown`。方法只接受对象参数；省略 params 按空对象校验。
`dashboard_call` 继续携带 `{ operation, input }`，沿用业务 Schema 与权限边界。

Gateway 生成 UUID 请求 ID；通用解析器接受字符串、有限数值与 null，并原样回传。
成功响应只有 result，失败响应只有 error。无 id 的调用是通知，即使未知方法、
非法业务参数或执行失败，也不会回送响应，只记录诊断。

服务端通知保留 13 个名称：`item.completed`、`conversation.stream.delta`、`typing.changed`、
`agent.wake`、`background_task.changed`、`managed_llm.authentication_failed`、`session.changed`、
`system.ready`、`system.status`、`thread.started`、`turn.started`、`turn.completed`、`turn.failed`。
原事件的路由字段与 payload 放进 params；Gateway 校验后转成内部 AgentEvent，
其 type、路由和 payload 保持，内部事件不包含协议版本。

`conversation.stream.delta.params.payload` 仍为现有展示 batch，包含有序 mutations。
`context_source` 允许省略或取 `estimated`、`usage_calibrated`。协议 batch 与展示 batch
是两个不同层次：前者合并 RPC 消息，后者承载一轮展示更新。

RPC batch 并发处理各项，只汇总有响应的条目；全通知 batch 不写响应，空数组返回
Invalid Request。Gateway 正常业务仍逐行发送单条请求，响应可乱序到达。

## 错误与连接生命周期

| 数值码 | 含义 |
| --- | --- |
| -32700 | JSON 解析失败 |
| -32600 | 非法协议封装或空 batch |
| -32601 | 未知方法 |
| -32602 | 业务参数校验失败 |
| -32603 | 协议内部处理错误 |
| -32000 | 业务执行异常 |
| -32001 | 尚未初始化 |
| -32002 | 业务协议版本不匹配 |

原字符串错误码放进 `error.data.code`。Gateway 保留字符串 code 和数值 rpcCode；
message 保留实际异常，脱敏后最多 8 KiB，截断时明确标记。错误不携带原始请求、
凭证、SDK 对象或堆栈。流式联合 Schema 的诊断按 mutation.kind 定位分支，指出
实际字段路径，避免 stream_updated 错误被描述为缺少 part。

`run_turn` 在任务结束后响应，期间继续推送通知；取消和 steering 独立分发。
Gateway 顺序交付通知，但独立匹配响应，慢回调不会堵住取消请求。消费者异常只记录，
不伪装成供应商或子进程失败。终态通知用于展示，run_turn 响应用于调度结算。

超时只结束本地等待，不自动重发任务；迟到和重复响应只记录诊断。子进程退出、
损坏响应、非法通知或无法关联的 null-id 协议错误，会拒绝待处理请求并结束连接。
恢复沿用现有有界退避配置，不重放已发送任务。进程代次隔离旧输出、退出回调与
排队通知，旧进程不能影响新连接。已经开始执行的消费者回调无法撤销，但不会继续
分发该事件的后续回调。

`shutdown` 等待初始化清理、取消工具并停止 runtime，写出 system.status 和响应，
stdout flush 完成后退出。重复 shutdown 等待同一次清理，不提前退出。
会话表、历史和用量仍属于 Bun runtime，通信迁移不修改数据库或 transcript。

## 验证

协议、agent-cli 服务端及 Gateway 子进程测试覆盖 13 个命令、13 类通知、batch、
版本握手、并发取消、错误脱敏、乱序响应、断连恢复和 context_source。
展示、IPC 和历史交接沿用相关定向回归。

从仓库根启动浏览器验收 fixture：

```sh
bun apps/dashboard/test/features/sessions/jsonrpc-fixture-server.ts
```

打开 `http://127.0.0.1:5198/test/features/sessions/jsonrpc-fixture.html`。
它使用真实 ProcessAgentRuntime、AgentProtocolServer、调度器、会话控制器与展示组件；
runtime host 和会话存储为内存 fixture。HTTP 仅用于验收页面桥接，不属于生产通信。
不调用模型、不读写生产数据库。退出 fixture 服务会关闭子进程。

2026-09-06 浏览器验收：发送后出现右侧用户气泡和分段文本；完成显示 completed；
生成期间点击停止显示 cancelled，正文和气泡保留，Gateway/agent-cli 始终 ready，
展示用量收到 context_tokens=100。该 fixture 不覆盖原生 Electron 窗口；IPC 用定向测试回归。

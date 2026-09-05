# 统一模型消息领域

2026-09-05：runtime 新增 `src/messages`，测试对应放在 `test/messages`，并更新仓库结构检查中的目录声明。

三个供应商协议共同使用 `AssistantMessage`、流事件与累积器；engine、observer 和历史重放也消费这份契约。因此把消息契约放在独立模块，避免由某个具体协议定义其他消费者的接口。协议字段转换、停止原因解释仍由 `providers` 负责，重试和工具执行仍由 `engine` 负责。

这个目录包含消息类型、生命周期累积器和重放来源判断，不新增存储归属或数据库表。既有会话保持可读。消费方式和边界见 [流事件说明](../harness/assistant-message-stream.md)。

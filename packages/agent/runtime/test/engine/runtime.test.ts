import { messageFixture, eventFixture } from "../message-fixtures";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createLogger, repositoryRoot, resolveWorkspaceContext } from "@lxe/core";
import type { AgentJob, DesktopStreamBatchRequest, EmitRequest, JsonObject } from "@lxe/protocol";
import { TypeScriptAgentRuntime } from "../../src/engine/runtime";
import {
  RuntimeProviderError,
  type RuntimeProviderManager,
  type RuntimeProviderSnapshot,
} from "../../src/providers/provider";
import { ToolExecutionError, ToolRegistry } from "../../src/tooling/registry";
import { WorkspaceSearchService } from "../../src/tooling/workspace-search";
import type {
  RuntimeHandle,
  RuntimeArtifactRecord,
  RuntimeMessage,
  RuntimeProviderRequest,
  RuntimeStore,
  RuntimeTurnContextRecord,
  AssistantMessage,
} from "../../src/engine/types";

const workspace = resolveWorkspaceContext(repositoryRoot(import.meta.dir));

const job = (overrides: Partial<AgentJob> = {}): AgentJob => ({
  job_id: "j1",
  session_id: "s1",
  session_key: "agent:main:feishu:dm:c1",
  response_route_id: "r1",
  user_id: "u1",
  conversation_id: "c1",
  is_group: false,
  message_id: "m1",
  user_input: "hello",
  job_kind: "turn",
  sender_nick: "Tester",
  source: { platform: "feishu", chat_id: "c1" },
  raw_data: {},
  user_content_blocks: [],
  diagnostics: [],
  workspace,
  ...overrides,
});

class MemoryStore implements RuntimeStore {
  messages: RuntimeMessage[] = [];
  pendingEvents: JsonObject[] = [];
  metrics: JsonObject[] = [];
  turnContexts: RuntimeTurnContextRecord[] = [];
  statePatches: JsonObject[] = [];
  replacements: RuntimeMessage[][] = [];
  artifacts: RuntimeArtifactRecord[] = [];
  turnErrors: Array<{ turn_id: string; message: string }> = [];
  operations: string[] = [];
  messageTurnIds: string[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async getSession(): Promise<{ session_id: string; source: JsonObject; workspace: typeof workspace }> {
    return {
      session_id: "s1",
      source: {
        platform: "feishu",
        extra: { bot_app_id: "cli_app", bot_id: "ou_bot", bot_name: "Shop Bot" },
      },
      workspace,
    };
  }
  async popPendingEvents(): Promise<JsonObject[]> {
    return this.pendingEvents.splice(0);
  }
  async loadMessages(): Promise<RuntimeMessage[]> { return structuredClone(this.messages); }
  async appendTurnContext(_sessionId: string, context: RuntimeTurnContextRecord): Promise<void> {
    this.turnContexts.push(structuredClone(context));
    this.operations.push("turn_context");
  }
  async appendArtifact(_sessionId: string, artifact: RuntimeArtifactRecord): Promise<void> {
    this.artifacts.push(structuredClone(artifact));
    this.operations.push("artifact");
  }
  async appendTurnError(_sessionId: string, turnId: string, message: string): Promise<void> {
    this.turnErrors.push({ turn_id: turnId, message });
    this.operations.push("turn_error");
  }
  async resolveArtifact(_sessionId: string, artifactId: string): Promise<RuntimeArtifactRecord | undefined> {
    return this.artifacts.find((artifact) => artifact.artifact_id === artifactId);
  }
  async resolveAttachment(): Promise<undefined> { return undefined; }
  async attachmentPaths(): Promise<string[]> { return []; }
  async appendMessage(
    _sessionId: string,
    message: RuntimeMessage,
    _reason?: string,
    turnId?: string,
  ): Promise<void> {
    this.messages.push(message);
    this.messageTurnIds.push(turnId ?? "");
    this.operations.push("message");
  }
  async replaceMessages(_sessionId: string, messages: RuntimeMessage[]): Promise<void> {
    this.messages = structuredClone(messages);
    this.replacements.push(structuredClone(messages));
  }
  async patchSessionState(_sessionId: string, patch: JsonObject): Promise<void> { this.statePatches.push(patch); }
  async recordTurn(_sessionId: string, metrics: JsonObject): Promise<void> { this.metrics.push(metrics); }
}

const summarize = async () => ({
  text: "context summary",
  usage: { input_tokens: 0, output_tokens: 0 },
});

const handle = (): RuntimeHandle => {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    cancelled: false,
    drainSteering: () => [],
    registerProcess: () => () => undefined,
  };
};

const lxeSkillInvocationError = (details: JsonObject = {
  type: "lxeskill_invocation_error",
  violations: ["shell_composition"],
  required_command_shape: "lxeskill <command> [options]",
  use_exec_cwd: true,
  canonical_command_path: "lxeskill fba shipment delivery-csv-download",
  owner_skills: ["fba-shipment-delivery-csv-download"],
  describe_command: "lxeskill describe fba shipment delivery-csv-download",
}): ToolExecutionError => new ToolExecutionError(
  "unsupported_invocation",
  "Invalid lxeskill invocation: use one standalone lxeskill command.",
  details,
  "lxeskill_invocation",
);

describe("TypeScriptAgentRuntime", () => {
  test("reports persisted message and usage changes without reporting failed writes", async () => {
    const changes: string[] = [];
    const store = new MemoryStore();
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      provider: {
        summarize,
        turn: async () => (messageFixture({
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
          usage: { input_tokens: 1, output_tokens: 1 },
        })),
      },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
      onSessionChanged: (sessionId, change) => { changes.push(`${sessionId}:${change}`); },
    });
    await runtime.start();
    await runtime.runTurn(job(), handle());
    expect(changes).toEqual(["s1:messages", "s1:messages", "s1:usage"]);
    expect(store.messageTurnIds).toEqual(["j1", "j1"]);
    expect(store.metrics[0]).toMatchObject({
      platform: "feishu",
      bot_app_id: "cli_app",
      bot_id: "ou_bot",
      bot_name: "Shop Bot",
      provider: "custom",
      model: "",
    });
    await runtime.stop();

    const failedUsageChanges: string[] = [];
    const failedUsageStore = new MemoryStore();
    failedUsageStore.recordTurn = async () => { throw new Error("usage write failed"); };
    const failedUsageRuntime = new TypeScriptAgentRuntime({
      store: failedUsageStore,
      tools: new ToolRegistry(),
      provider: {
        summarize,
        turn: async () => (messageFixture({
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
          usage: { input_tokens: 1, output_tokens: 1 },
        })),
      },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
      onSessionChanged: (_sessionId, change) => { failedUsageChanges.push(change); },
    });
    await failedUsageRuntime.start();
    await failedUsageRuntime.runTurn(job(), handle());
    expect(failedUsageChanges).toEqual(["messages", "messages"]);
    await failedUsageRuntime.stop();

    const failedMessageChanges: string[] = [];
    const failedMessageStore = new MemoryStore();
    failedMessageStore.appendMessage = async () => { throw new Error("message write failed"); };
    const failedMessageRuntime = new TypeScriptAgentRuntime({
      store: failedMessageStore,
      tools: new ToolRegistry(),
      provider: {
        summarize,
        turn: async () => (messageFixture({
          content: [{ type: "text", text: "unreachable" }],
          stopReason: "stop",
          usage: { input_tokens: 1, output_tokens: 1 },
        })),
      },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
      onSessionChanged: (_sessionId, change) => { failedMessageChanges.push(change); },
    });
    await failedMessageRuntime.start();
    expect((await failedMessageRuntime.runTurn(job(), handle())).status).toBe("error");
    expect(failedMessageChanges).toEqual(["messages", "usage"]);
    await failedMessageRuntime.stop();
  });

  test("keeps local file and image blocks in the current turn and announces attachment persistence", async () => {
    const store = new MemoryStore();
    const changes: string[] = [];
    let observedUserContent: RuntimeMessage["content"] | undefined;
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      provider: {
        summarize,
        turn: async (request) => {
          observedUserContent = [...request.messages].reverse().find((message) => message.role === "user")?.content;
          return messageFixture({
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        },
      },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
      onSessionChanged: (_sessionId, change) => { changes.push(change); },
    });
    await runtime.start();
    await runtime.runTurn(job({
      user_input: "analyze it",
      user_content_blocks: [
        {
          type: "local_file",
          attachment_id: "attachment-1",
          turn_id: "j1",
          path: "/private/input/photo.png",
          name: "photo.png",
          size_bytes: 12,
          media_type: "image/png",
          ts: 1,
        },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "encoded" } },
        { type: "text", text: "analyze it" },
      ],
    }), handle());
    expect(observedUserContent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "local_file", path: "/private/input/photo.png" }),
      expect.objectContaining({ type: "image" }),
    ]));
    expect(changes).toEqual(["messages", "attachments", "messages", "usage"]);
    await runtime.stop();
  });

  test("sums cached input tokens across steps into the recorded turn usage", async () => {
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    tools.register({
      name: "probe",
      description: "probe",
      input_schema: { type: "object" },
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
    let providerCalls = 0;
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools,
      provider: {
        summarize,
        turn: async () => {
          providerCalls += 1;
          // A cache hit bills only the remainder as input_tokens, so a turn that
          // reports 207 has really sent 207 + 16128 + 64 tokens.
          return providerCalls === 1
            ? messageFixture({
                content: [{ type: "tool_call", id: "probe-1", name: "probe", arguments: {} }],
                stopReason: "toolUse",
                usage: {
                  input_tokens: 207,
                  output_tokens: 310,
                  cache_read_input_tokens: 16_128,
                  cache_creation_input_tokens: 64,
                },
              })
            : messageFixture({
                content: [{ type: "text", text: "done" }],
                stopReason: "stop",
                usage: {
                  input_tokens: 12,
                  output_tokens: 8,
                  cache_read_input_tokens: 16_400,
                  cache_creation_input_tokens: 0,
                },
              });
        },
      },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
    });
    await runtime.start();
    await runtime.runTurn(job(), handle());
    expect(store.metrics[0]).toMatchObject({
      input_tokens: 219,
      output_tokens: 318,
      cache_read_input_tokens: 32_528,
      cache_creation_input_tokens: 64,
    });
    await runtime.stop();
  });

  test("records zero cache tokens when the provider reports none", async () => {
    const store = new MemoryStore();
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      provider: {
        summarize,
        turn: async () => (messageFixture({
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
          usage: { input_tokens: 5, output_tokens: 6 },
        })),
      },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
    });
    await runtime.start();
    await runtime.runTurn(job(), handle());
    expect(store.metrics[0]).toMatchObject({
      input_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    await runtime.stop();
  });

  test("holds one workspace snapshot lease across prompt and tool execution", async () => {
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    const search = new WorkspaceSearchService(workspace.worktree);
    let released = 0;
    let disposed = 0;
    let promptInstructions = "";
    tools.register({
      name: "probe",
      description: "probe",
      input_schema: { type: "object" },
      execute: async (_input, context) => {
        expect(context.workspaceSearch).toBe(search);
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    let providerCalls = 0;
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools,
      workspaceInstances: {
        acquire: async () => ({
          workspace,
          search,
          snapshot: Object.freeze({
            generation: 7,
            loaded_at: 1,
            instructions_prompt: "Workspace rule",
            skills: Object.freeze({ names: Object.freeze([]), modules: Object.freeze({}), prompt: "" }),
            soul: "Cached soul",
          }),
          release: () => { released += 1; },
        }),
        disposeAll: async () => { disposed += 1; },
      },
      provider: {
        summarize,
        turn: async () => {
          providerCalls += 1;
          return providerCalls === 1
            ? messageFixture({ content: [{ type: "tool_call", id: "probe-1", name: "probe", arguments: {} }], stopReason: "toolUse", usage: { input_tokens: 1, output_tokens: 1 } })
            : messageFixture({ content: [{ type: "text", text: "done" }], stopReason: "stop", usage: { input_tokens: 1, output_tokens: 1 } });
        },
      },
      systemPrompt: (context) => {
        promptInstructions = context.workspaceSnapshot?.instructions_prompt ?? "";
        return "test";
      },
      emitter: { emit: async () => undefined, typing: async () => undefined },
    });
    await runtime.start();
    await runtime.runTurn(job(), handle());
    expect(promptInstructions).toBe("Workspace rule");
    expect(released).toBe(1);
    await runtime.stop();
    expect(disposed).toBe(1);
  });

  test("rejects an AgentJob whose workspace differs from the persisted session", async () => {
    const store = new MemoryStore();
    let providerCalled = false;
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      provider: {
        summarize,
        turn: async () => {
          providerCalled = true;
          throw new Error("provider must not run");
        },
      },
      systemPrompt: "test",
      emitter: { emit: async () => undefined, typing: async () => undefined },
    });
    await runtime.start();
    await expect(runtime.runTurn({
      ...job(),
      workspace: { ...workspace, directory: join(workspace.worktree, "another-directory") },
    }, handle())).rejects.toThrow("job workspace does not match session");
    expect(providerCalled).toBe(false);
    await runtime.stop();
  });

  test("sends structured lxeskill recovery to the model while keeping tool display concise", async () => {
    const store = new MemoryStore();
    const emitted: EmitRequest[] = [];
    const commands: string[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: "exec",
      description: "exec",
      input_schema: { type: "object" },
      execute: async (input) => {
        const command = String(input.command ?? "");
        commands.push(command);
        if (command !== "lxeskill fba shipment delivery-csv-download --delivery-no SP260703001") {
          throw lxeSkillInvocationError({
            type: "lxeskill_invocation_error",
            violations: ["direct_business_module", "shell_composition"],
            required_command_shape: "lxeskill <command> [options]",
            use_exec_cwd: true,
            discovery_command: "lxeskill list",
          });
        }
        return { content: [{ type: "text", text: "downloaded" }] };
      },
    });
    let providerCalls = 0;
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools,
      provider: { summarize, turn: async (request) => {
        providerCalls += 1;
        if (providerCalls === 1) {
          return messageFixture({
            content: [{
              type: "tool_call", id: "bad", name: "exec",
              arguments: {
                command: "cd /Users/llxx/Projects/github/LXE_AGENT_LOCAL_FBA && uv run --frozen python -m services.agent_cli.mabang.download_shipment_delivery --delivery-no SP260703001",
              },
            }],
            stopReason: "toolUse",
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        }
        if (providerCalls === 2) {
          const last = request.messages.at(-1)?.content;
          const block = Array.isArray(last) ? last[0] : undefined;
          const payload = JSON.parse(String(block?.content ?? "{}"));
          expect(payload).toMatchObject({
            type: "lxeskill_invocation_error",
            attempt: 1,
            retryable: true,
            discovery_command: "lxeskill list",
            next_action: "read_owner_skill_or_run_standalone_describe_then_retry_once",
          });
          return messageFixture({
            content: [{
              type: "tool_call", id: "good", name: "exec",
              arguments: { command: "lxeskill fba shipment delivery-csv-download --delivery-no SP260703001" },
            }],
            stopReason: "toolUse",
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        }
        return messageFixture({
          content: [{ type: "text", text: "complete" }],
          stopReason: "stop",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      } },
      emitter: {
        emit: async (request) => { emitted.push(request); },
        typing: async () => undefined,
      },
      systemPrompt: "test",
    });

    await runtime.start();
    await runtime.runTurn(job(), handle());
    await runtime.stop();

    expect(commands).toEqual([
      "cd /Users/llxx/Projects/github/LXE_AGENT_LOCAL_FBA && uv run --frozen python -m services.agent_cli.mabang.download_shipment_delivery --delivery-no SP260703001",
      "lxeskill fba shipment delivery-csv-download --delivery-no SP260703001",
    ]);
    const display = JSON.stringify(emitted);
    expect(display).toContain("Invalid lxeskill invocation");
    expect(display).not.toContain("canonical_command_path");
    expect(display).not.toContain("violations");
  });

  test("limits lxeskill invocation recovery per turn and resets it for the next turn", async () => {
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    tools.register({
      name: "exec",
      description: "exec",
      input_schema: { type: "object" },
      execute: async () => { throw lxeSkillInvocationError(); },
    });
    const responses: AssistantMessage[] = [
      messageFixture({ content: [{ type: "tool_call", id: "bad-1", name: "exec", arguments: {} }], stopReason: "toolUse", usage: { input_tokens: 1, output_tokens: 1 } }),
      messageFixture({ content: [{ type: "tool_call", id: "bad-2", name: "exec", arguments: {} }], stopReason: "toolUse", usage: { input_tokens: 1, output_tokens: 1 } }),
      messageFixture({ content: [{ type: "text", text: "stopped" }], stopReason: "stop", usage: { input_tokens: 1, output_tokens: 1 } }),
      messageFixture({ content: [{ type: "tool_call", id: "bad-3", name: "exec", arguments: {} }], stopReason: "toolUse", usage: { input_tokens: 1, output_tokens: 1 } }),
      messageFixture({ content: [{ type: "text", text: "stopped" }], stopReason: "stop", usage: { input_tokens: 1, output_tokens: 1 } }),
    ];
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools,
      provider: { summarize, turn: async () => responses.shift()! },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
    });

    await runtime.start();
    await runtime.runTurn(job(), handle());
    await runtime.runTurn({ ...job(), job_id: "j2", message_id: "m2" }, handle());
    await runtime.stop();

    const recoveries = store.messages.flatMap((message) =>
      message.role === "tool" && Array.isArray(message.content)
        ? message.content.filter((block) => block.type === "tool_result")
        : []
    ).map((block) => JSON.parse(String(block.content)));
    expect(recoveries.map((payload) => ({ attempt: payload.attempt, retryable: payload.retryable }))).toEqual([
      { attempt: 1, retryable: true },
      { attempt: 2, retryable: false },
      { attempt: 1, retryable: true },
    ]);
    expect(recoveries[1]?.next_action).toBe("stop_retrying_shell_variations_and_report");
  });

  test("records skill activation once and attributes every later lxeskill execution independently", async () => {
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    const executionSkillNames: Array<readonly string[]> = [];
    const promptSkillNames: string[] = [];
    const emitted: EmitRequest[] = [];
    let snapshotCalls = 0;
    tools.register({
      name: "read",
      description: "read skill",
      input_schema: { type: "object" },
      execute: async (_input, context) => {
        await context.exposureState?.activateSkill("replenishment-store-resolve");
        return { content: [{ type: "text", text: "skill loaded" }] };
      },
    });
    tools.register({
      name: "exec",
      description: "exec",
      input_schema: { type: "object" },
      classifyInvocation: () => ({
        usageName: "lxeskill:replenish store resolve",
        commandId: "replenish store resolve",
        ownerSkills: [
          "replenishment-store-resolve",
          "replenishment-unlinked-shipment-download",
          "replenishment-sales-analyze",
          "replenishment-real-inventory-report",
          "replenishment-msku-download",
          "replenishment-calculate",
          "replenishment-amazon-restock-inventory-snapshot",
        ],
        attributionSkill: "replenishment-store-resolve",
      }),
      execute: async (input, context) => {
        executionSkillNames.push(context.skill_names ?? []);
        if (input.fail === true) throw new Error("command failed");
        return { content: [{ type: "text", text: "done" }] };
      },
    });
    const responses: AssistantMessage[] = [
      messageFixture({ content: [
        { type: "tool_call", id: "read-1", name: "read", arguments: {} },
        { type: "tool_call", id: "read-2", name: "read", arguments: {} },
      ], stopReason: "toolUse", usage: { input_tokens: 1, output_tokens: 1 } }),
      messageFixture({ content: [{ type: "text", text: "complete" }], stopReason: "stop", usage: { input_tokens: 1, output_tokens: 1 } }),
      messageFixture({ content: [
        { type: "tool_call", id: "exec-1", name: "exec", arguments: { command: "lxeskill replenish store resolve --store-name Demo" } },
        { type: "tool_call", id: "exec-2", name: "exec", arguments: { command: "lxeskill replenish store resolve --store-name Demo", fail: true } },
      ], stopReason: "toolUse", usage: { input_tokens: 1, output_tokens: 1 } }),
      messageFixture({ content: [{ type: "text", text: "complete" }], stopReason: "stop", usage: { input_tokens: 1, output_tokens: 1 } }),
    ];
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools,
      provider: { summarize, turn: async () => responses.shift()! },
      emitter: { emit: async (request) => { emitted.push(request); }, typing: async () => undefined },
      systemPrompt: (context) => {
        promptSkillNames.push(context.skillPrompt);
        return context.skillPrompt;
      },
      skillSnapshot: () => {
        snapshotCalls += 1;
        return {
          names: ["replenishment-store-resolve"],
          prompt: "skills: replenishment-store-resolve",
          modules: { "replenishment-store-resolve": "amazon_replenish" },
        };
      },
    });

    await runtime.start();
    await runtime.runTurn(job(), handle());
    await runtime.runTurn({ ...job(), job_id: "j2", message_id: "m2" }, handle());
    await runtime.stop();

    expect(snapshotCalls).toBe(2);
    expect(promptSkillNames).toEqual([
      "skills: replenishment-store-resolve",
      "skills: replenishment-store-resolve",
    ]);
    expect(executionSkillNames).toEqual([
      ["replenishment-store-resolve"],
      ["replenishment-store-resolve"],
    ]);
    expect(store.metrics[0]?.activations).toEqual([{
      skill: "replenishment-store-resolve",
      module: "amazon_replenish",
    }]);
    expect(store.metrics[0]?.executions).toEqual([]);
    expect(store.metrics[1]?.tools).toContainEqual(expect.objectContaining({
      name: "lxeskill:replenish store resolve",
      calls: 2,
      errors: 1,
    }));
    expect(store.metrics[1]?.activations).toEqual([]);
    expect(store.metrics[1]?.executions).toEqual([
      expect.objectContaining({
        skill: "replenishment-store-resolve",
        module: "amazon_replenish",
        command: "replenish store resolve",
        success: true,
      }),
      expect.objectContaining({
        skill: "replenishment-store-resolve",
        module: "amazon_replenish",
        command: "replenish store resolve",
        success: false,
      }),
    ]);
    expect(JSON.stringify(store.metrics[1]?.executions)).not.toContain("--store-name");
    const failedToolResult = store.messages.flatMap((message) =>
      message.role === "tool" && Array.isArray(message.content)
        ? message.content.filter((block) => block.type === "tool_result" && block.is_error === true)
        : []
    ).at(-1);
    expect(JSON.parse(String(failedToolResult?.content))).toMatchObject({
      type: "tool_failure",
      code: "unclassified",
      operation: "exec",
      cause_known: false,
      observed_message: "command failed",
      inference_policy: "verified_reason_only",
    });
    const displayedFailure = emitted.flatMap((request) => request.tool_steps)
      .find((step) => step.id === "exec-2" && step.status === "error");
    expect(displayedFailure?.error_block?.content).toBe("command failed");
  });

  test("does not count static tool ownership as a skill execution", async () => {
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    tools.register({
      name: "owned_tool",
      description: "owned without a stable command",
      input_schema: { type: "object" },
      ownerSkills: ["demo-skill"],
      execute: async () => ({ content: [{ type: "text", text: "done" }] }),
    });
    const responses: AssistantMessage[] = [
      messageFixture({ content: [{ type: "tool_call", id: "tool-1", name: "owned_tool", arguments: {} }], stopReason: "toolUse", usage: { input_tokens: 1, output_tokens: 1 } }),
      messageFixture({ content: [{ type: "text", text: "complete" }], stopReason: "stop", usage: { input_tokens: 1, output_tokens: 1 } }),
    ];
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools,
      toolExposure: { allowedSkills: new Set(["demo-skill"]) },
      provider: { summarize, turn: async () => responses.shift()! },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
    });

    await runtime.start();
    await runtime.runTurn(job(), handle());
    await runtime.stop();

    expect(store.metrics[0]?.executions).toEqual([]);
  });

  test("completes an empty heartbeat without loading history or calling the provider", async () => {
    const store = new MemoryStore();
    store.messages.push({ role: "user", content: "private history" });
    let calls = 0;
    let snapshotCalls = 0;
    let systemPromptCalls = 0;
    let wireTurns = 0;
    let wireAttempts = 0;
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      provider: {
        summarize,
        turn: async () => {
          calls += 1;
          throw new Error("provider must not be called");
        },
      },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      skillSnapshot: () => {
        snapshotCalls += 1;
        return { names: [], prompt: "", modules: {} };
      },
      systemPrompt: () => {
        systemPromptCalls += 1;
        return "test";
      },
      wireTraceController: {
        startTurn: () => {
          wireTurns += 1;
          return {
            startProviderAttempt: () => {
              wireAttempts += 1;
              return undefined;
            },
          };
        },
      },
    });
    await runtime.start();
    const outcome = await runtime.runTurn({ ...job(), job_kind: "heartbeat", user_input: "" }, handle());
    expect(outcome).toEqual(expect.objectContaining({ status: "completed", reply: "" }));
    expect(calls).toBe(0);
    expect(store.messages).toEqual([{ role: "user", content: "private history" }]);
    expect(store.turnContexts).toEqual([]);
    expect(snapshotCalls).toBe(0);
    expect(systemPromptCalls).toBe(0);
    expect(wireTurns).toBe(1);
    expect(wireAttempts).toBe(0);
    expect(store.metrics).toContainEqual(expect.objectContaining({ status: "completed", api_calls: 0 }));
  });

  test("keeps concurrent turns on the skill snapshot acquired at their own start", async () => {
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    tools.register({
      name: "first_tool", description: "first", input_schema: { type: "object" },
      ownerSkills: ["first"], execute: async () => ({ content: [] }),
    });
    tools.register({
      name: "second_tool", description: "second", input_schema: { type: "object" },
      ownerSkills: ["second"], execute: async () => ({ content: [] }),
    });
    tools.register({
      name: "first_connector_tool", description: "first connector", input_schema: { type: "object" },
      connectorName: "first-connector", execute: async () => ({ content: [] }),
    });
    tools.register({
      name: "second_connector_tool", description: "second connector", input_schema: { type: "object" },
      connectorName: "second-connector", execute: async () => ({ content: [] }),
    });
    let current = {
      names: ["first"] as readonly string[],
      prompt: "prompt:first",
      modules: { first: "module:first" } as Readonly<Record<string, string>>,
      disabledConnectorIds: ["second-connector"] as readonly string[],
    };
    let snapshotCalls = 0;
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstEnteredPromise = new Promise<void>((resolve) => { firstEntered = resolve; });
    const firstReleasePromise = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const requests: Array<{ system: string; tools: string[] }> = [];
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools,
      skillSnapshot: () => {
        snapshotCalls += 1;
        return current;
      },
      provider: {
        summarize,
        turn: async (request) => {
          requests.push({ system: request.system, tools: request.tools.map((tool) => tool.name) });
          if (request.system === "prompt:first") {
            firstEntered();
            await firstReleasePromise;
          }
          return messageFixture({
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        },
      },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: (context) => context.skillPrompt,
    });
    await runtime.start();
    const firstTurn = runtime.runTurn({ ...job(), response_route_id: "" }, handle());
    await firstEnteredPromise;
    current = {
      names: ["second"],
      prompt: "prompt:second",
      modules: { second: "module:second" },
      disabledConnectorIds: ["first-connector"],
    };
    const secondTurn = runtime.runTurn({
      ...job(), job_id: "j2", message_id: "m2", session_id: "s2", response_route_id: "",
    }, handle());
    await secondTurn;
    releaseFirst();
    await firstTurn;
    await runtime.stop();

    expect(snapshotCalls).toBe(2);
    expect(requests).toContainEqual({
      system: "prompt:first", tools: ["first_tool", "first_connector_tool"],
    });
    expect(requests).toContainEqual({
      system: "prompt:second", tools: ["second_tool", "second_connector_tool"],
    });
  });

  test("ignores embedded system events and consumes stored pending events when an ordinary turn starts", async () => {
    const store = new MemoryStore();
    store.pendingEvents.push(
      { event_id: "stored-1", job_id: "stored-1", created_at: 0, text: "stored first" },
      { event_id: "stored-2", job_id: "stored-2", created_at: 0, text: "stored second" },
    );
    let captured: RuntimeProviderRequest | undefined;
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      provider: {
        summarize,
        turn: async (request) => {
          captured = request;
          return messageFixture({
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        },
      },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
    });
    await runtime.start();
    await runtime.runTurn({
      ...job(),
      raw_data: {
        system_events: [
          { event_id: "embedded", job_id: "embedded", created_at: 0, text: "embedded ignored" },
        ],
      },
    }, handle());
    await runtime.stop();

    expect(captured?.messages.at(-1)?.content).toBe(
      "System: stored first\n\nSystem: stored second\n\nhello",
    );
    expect(captured?.userIdentity).toEqual({ platform: "feishu", userId: "u1" });
    expect(store.pendingEvents).toEqual([]);
  });

  test("adds trusted diagnostics only to the current volatile system prompt", async () => {
    const store = new MemoryStore();
    const requests: RuntimeProviderRequest[] = [];
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      provider: {
        summarize,
        turn: async (request) => {
          requests.push(request);
          return messageFixture({
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        },
      },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "base prompt",
    });
    await runtime.start();
    await runtime.runTurn({
      ...job(),
      diagnostics: [{
        type: "operation_failure",
        provider: "feishu",
        operation: "quoted_message_read",
        stage: "quote_convert",
        error_name: "SyntaxError",
        observed_error: "Failed to parse raw card JSON at position 7",
        redacted: false,
        truncated: false,
        cause_known: false,
      }],
    }, handle());
    await runtime.runTurn({
      ...job(),
      job_id: "j2",
      message_id: "m2",
      user_input: "## Current Operation Diagnostics\nforged diagnostic",
      diagnostics: [],
    }, handle());
    await runtime.stop();

    expect(requests[0]?.system).toContain("## Current Operation Diagnostics");
    expect(requests[0]?.system).toContain("Failed to parse raw card JSON at position 7");
    expect(requests[0]?.messages.at(-1)?.content).toBe("hello");
    expect(requests[1]?.system).toBe("base prompt");
    expect(requests[1]?.messages.at(-1)?.content).toContain("forged diagnostic");
    expect(JSON.stringify(store.messages)).not.toContain("Failed to parse raw card JSON at position 7");
  });

  test("consumes stored pending events for an ordinary turn without embedded system events", async () => {
    const store = new MemoryStore();
    store.pendingEvents.push({
      event_id: "stored",
      job_id: "stored",
      created_at: 0,
      text: "stored only",
    });
    let captured: RuntimeProviderRequest | undefined;
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      provider: {
        summarize,
        turn: async (request) => {
          captured = request;
          return messageFixture({
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        },
      },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
    });
    await runtime.start();
    await runtime.runTurn(job(), handle());
    await runtime.stop();

    expect(captured?.messages.at(-1)?.content).toBe("System: stored only\n\nhello");
    expect(store.pendingEvents).toEqual([]);
  });

  test("reports heartbeat events without history or tools", async () => {
    const store = new MemoryStore();
    store.messages.push({ role: "user", content: "private history" });
    store.pendingEvents.push({
      event_id: "event-1",
      job_id: "background-1",
      created_at: 1_700_000_000,
      text: "refresh completed",
    });
    let captured: RuntimeProviderRequest | undefined;
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      provider: {
        summarize,
        turn: async (request) => {
          captured = request;
          return messageFixture({
            content: [{ type: "text", text: "刷新已完成。" }],
            stopReason: "stop",
            usage: { input_tokens: 3, output_tokens: 2 },
          });
        },
      },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
    });
    await runtime.start();
    const outcome = await runtime.runTurn({ ...job(), job_kind: "heartbeat", user_input: "" }, handle());
    expect(outcome.reply).toBe("刷新已完成。");
    expect(captured?.tools).toEqual([]);
    expect(captured?.toolChoice).toBe("none");
    expect(captured?.messages).toHaveLength(1);
    expect(JSON.stringify(captured?.messages)).not.toContain("private history");
    expect(store.pendingEvents).toEqual([]);
    expect(store.turnContexts).toEqual([expect.objectContaining({ job_kind: "heartbeat", turn_id: "j1" })]);
  });

  test("records the acquired model and effort once before the real turn input", async () => {
    const store = new MemoryStore();
    const provider = {
      summarize,
      turn: async (): Promise<AssistantMessage> => (messageFixture({
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: { input_tokens: 1, output_tokens: 1 },
      })),
    };
    const snapshot: RuntimeProviderSnapshot = {
      generation: 7,
      descriptor: {
        name: "kimi_coding",
        model: "kimi-for-coding",
        apiStyle: "anthropic_messages",
        baseURL: "https://secret.invalid",
        apiKey: "must-not-be-persisted",
        maxTokens: 4096,
        defaultHeaders: { Authorization: "secret" },
        thinkingStyle: "effort",
        thinkingLevels: ["off", "high"],
        thinkingDefault: "high",
        thinkingEnabled: true,
        thinkingEffort: "high",
        thinkingDisplay: "omitted",
        contextWindowTokens: 256_000,
        requestIdleTimeoutMs: 1_000,
      },
      provider,
    };
    const providerManager: RuntimeProviderManager = {
      acquire: () => snapshot,
      reconfigure: async () => snapshot,
    };
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      providerManager,
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
    });
    await runtime.start();
    await runtime.runTurn(job(), handle());
    expect(store.turnContexts).toEqual([{
      turn_id: "j1",
      job_kind: "turn",
      provider: "kimi_coding",
      model: "kimi-for-coding",
      credential_source: "local",
      effort: "high",
      thinking_enabled: true,
      provider_generation: 7,
      context_window_tokens: 256_000,
      ts: expect.any(Number),
    }]);
    expect(store.operations.slice(0, 2)).toEqual(["turn_context", "message"]);
    expect(JSON.stringify(store.turnContexts)).not.toContain("must-not-be-persisted");
    expect(JSON.stringify(store.turnContexts)).not.toContain("secret.invalid");
    await runtime.stop();
  });

  test("disables tools on the last step and ignores a violating tool call", async () => {
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    let executed = false;
    tools.register({
      name: "danger",
      description: "must not execute",
      input_schema: { type: "object" },
      execute: async () => {
        executed = true;
        return { content: [{ type: "text", text: "bad" }] };
      },
    });
    const requests: Array<{ tools: unknown[]; toolChoice: string }> = [];
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools,
      maxSteps: 1,
      provider: {
        summarize,
        turn: async (request) => {
          requests.push({ tools: request.tools, toolChoice: request.toolChoice });
          return messageFixture({
            content: [
              { type: "text", text: "Here is the available result." },
              { type: "tool_call", id: "late", name: "danger", arguments: {} },
            ],
            stopReason: "toolUse",
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        },
      },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
    });
    await runtime.start();
    const outcome = await runtime.runTurn(job(), handle());
    expect(requests).toEqual([{ tools: [], toolChoice: "none" }]);
    expect(executed).toBe(false);
    expect(outcome.reply).toBe("Here is the available result.");
    expect(store.messages.at(-1)?.content).toEqual([{ type: "text", text: "Here is the available result." }]);
  });

  test("closes a tool call, persists canonical messages, and emits the final answer", async () => {
    const responses: AssistantMessage[] = [
      messageFixture({
        content: [{ type: "tool_call", id: "tool-1", name: "echo", arguments: { text: "hi" } }],
        stopReason: "toolUse",
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
      messageFixture({
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: { input_tokens: 5, output_tokens: 1 },
      }),
    ];
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "echo text",
      input_schema: { type: "object", properties: { text: { type: "string" } } },
      execute: async (input) => {
        await Bun.sleep(160);
        return { content: [{ type: "text", text: String(input.text) }] };
      },
    });
    const emitted: EmitRequest[] = [];
    const services: string[] = [];
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools,
      provider: { summarize, turn: async (request) => {
        if (responses.length === 2) await Bun.sleep(160);
        if (responses.length === 1) await request.onEvent?.(eventFixture("text_delta", "text-1", "done"));
        return responses.shift()!;
      } },
      emitter: { emit: async (request) => { emitted.push(request); }, typing: async () => undefined },
      systemPrompt: "You are LXE.",
      services: [{
        start: async () => { services.push("start"); },
        stop: async () => { services.push("stop"); },
      }],
    });
    await runtime.start();
    const outcome = await runtime.runTurn(job(), handle());
    expect(outcome).toEqual(expect.objectContaining({ status: "completed", reply: "done" }));
    expect(store.messages.map((message) => message.role)).toEqual([
      "user", "assistant", "tool", "assistant",
    ]);
    expect(store.messages[2]?.content).toEqual([
      expect.objectContaining({ type: "tool_result", tool_call_id: "tool-1" }),
    ]);
    const streamFrames = emitted.filter((request) => request.emit_kind === "stream");
    expect(streamFrames.at(-1)).toEqual(expect.objectContaining({
      session_id: "s1",
      response_route_id: "r1",
      content: "done",
      emit_kind: "stream",
      stream_type: "final_answer",
      state: "final",
      tool_steps: [expect.objectContaining({
        id: "tool-1",
        name: "echo",
        status: "success",
      })],
    }));
    expect(emitted.some((request) => request.emit_kind === "final")).toBe(false);
    const terminalStream = streamFrames.at(-1);
    if (terminalStream?.emit_kind !== "stream") throw new Error("terminal stream expected");
    expect(terminalStream.process_parts.map((part) => part.type)).toEqual(["tool", "text"]);
    expect(terminalStream.process_parts[0]).toEqual(expect.objectContaining({
      type: "tool",
      tool_step: expect.objectContaining({ id: "tool-1", status: "success" }),
    }));
    expect(terminalStream.process_parts[1]).toEqual(expect.objectContaining({
      type: "text",
      presentation: "final",
      text: "done",
    }));
    expect(new Set(streamFrames.map((request) => request.emit_id)).size).toBe(1);
    expect(streamFrames.map((request) => request.seq)).toEqual(
      streamFrames.map((_, index) => index + 1),
    );
    const phases = streamFrames.flatMap((request) => request.display_metrics?.phase ?? []);
    expect(phases).toContain("preparing_context");
    expect(phases).toContain("waiting_model");
    expect(phases).toContain("running_tool");
    expect(phases.at(-1)).toBe("generating_answer");
    await runtime.stop();
    expect(services).toEqual(["start", "stop"]);
  });

  test("runs only adjacent opted-in tools concurrently and preserves result order across barriers", async () => {
    const responses: AssistantMessage[] = [
      messageFixture({
        content: [
          { type: "tool_call", id: "t1", name: "exec", arguments: { label: "a", delay: 80 } },
          { type: "tool_call", id: "t2", name: "exec", arguments: { label: "b", delay: 20, fail: true } },
          { type: "tool_call", id: "t3", name: "read", arguments: {} },
          { type: "tool_call", id: "t4", name: "wait", arguments: { label: "c", delay: 40 } },
          { type: "tool_call", id: "t5", name: "wait", arguments: { label: "d", delay: 40 } },
        ],
        stopReason: "toolUse",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      messageFixture({
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ];
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    const events: string[] = [];
    const parallelExecute = async (input: JsonObject) => {
      const label = String(input.label);
      events.push(`start:${label}`);
      try {
        await Bun.sleep(Number(input.delay));
        if (input.fail === true) throw new Error(`failed ${label}`);
        return { content: [{ type: "text", text: `result ${label}` }] };
      } finally {
        events.push(`end:${label}`);
      }
    };
    tools.register({
      name: "exec", description: "exec", input_schema: { type: "object" },
      supportsParallelCalls: true,
      execute: parallelExecute,
    });
    tools.register({
      name: "read", description: "read", input_schema: { type: "object" },
      execute: async () => {
        events.push("start:read");
        await Bun.sleep(10);
        events.push("end:read");
        return { content: [{ type: "text", text: "read result" }] };
      },
    });
    tools.register({
      name: "wait", description: "wait", input_schema: { type: "object" },
      supportsParallelCalls: true,
      execute: parallelExecute,
    });
    const emitted: EmitRequest[] = [];
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools,
      provider: { summarize, turn: async () => responses.shift()! },
      emitter: { emit: async (request) => { emitted.push(request); }, typing: async () => undefined },
      systemPrompt: "test",
    });

    await runtime.start();
    const outcome = await runtime.runTurn(job(), handle());
    expect(outcome.status).toBe("completed");
    expect(events.slice(0, 2)).toEqual(["start:a", "start:b"]);
    expect(events.indexOf("start:read")).toBeGreaterThan(events.indexOf("end:a"));
    expect(events.indexOf("start:read")).toBeGreaterThan(events.indexOf("end:b"));
    expect(events.indexOf("start:c")).toBeGreaterThan(events.indexOf("end:read"));
    expect(events.indexOf("start:d")).toBeGreaterThan(events.indexOf("end:read"));
    expect(events.indexOf("start:d")).toBeLessThan(events.indexOf("end:c"));
    const toolMessage = store.messages.find((message) => message.role === "tool");
    if (!toolMessage || toolMessage.role !== "tool" || !Array.isArray(toolMessage.content)) throw new Error("tool results expected");
    expect(toolMessage.content.map((block) => block.tool_call_id)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    expect(toolMessage.content[1]).toEqual(expect.objectContaining({ tool_call_id: "t2", is_error: true }));
    expect(JSON.stringify(toolMessage.content[0]?.content)).toContain("result a");
    const terminal = emitted.slice().reverse().find((request) => request.emit_kind === "stream");
    expect(terminal?.tool_steps.map((tool) => tool.id)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    await runtime.stop();
  });

  test("streams a desktop turn while preserving a session originally created by Feishu", async () => {
    const store = new MemoryStore();
    const emitted: EmitRequest[] = [];
    const promptPlatforms: string[] = [];
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      provider: {
        summarize,
        turn: async (request) => {
          await request.onEvent?.(eventFixture("text_delta", "text-1", "desktop answer"));
          return messageFixture({
            content: [{ type: "text", text: "desktop answer" }],
            stopReason: "stop",
            usage: { input_tokens: 1, output_tokens: 2 },
          });
        },
      },
      emitter: { emit: async (request) => { emitted.push(request); }, typing: async () => undefined },
      systemPrompt: (context) => {
        promptPlatforms.push(context.platform);
        return "test";
      },
    });
    await runtime.start();
    await runtime.runTurn({
      ...job(),
      source: { platform: "desktop", chat_id: "s1", chat_type: "dm" },
      session_key: "agent:main:desktop:session:s1",
    }, handle());

    expect(promptPlatforms).toEqual(["desktop"]);
    expect(emitted.some((request) => request.emit_kind === "stream" && request.content === "desktop answer"))
      .toBe(true);
    expect(store.metrics[0]).toMatchObject({ platform: "desktop" });
    expect((await store.getSession()).source.platform).toBe("feishu");
    await runtime.stop();
  });

  test("uses lightweight batches for Desktop and a full terminal reconciliation frame", async () => {
    const store = new MemoryStore();
    const frames: EmitRequest[] = [];
    const batches: DesktopStreamBatchRequest[] = [];
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      provider: {
        summarize,
        turn: async (request) => {
          await request.onEvent?.(eventFixture("text_start", "answer-1", ""));
          for (const text of ["desktop ", "answer"]) {
            await request.onEvent?.(eventFixture("text_delta", "answer-1", text));
          }
          await request.onEvent?.(eventFixture("text_end", "answer-1", ""));
          return messageFixture({
            content: [{ type: "text", text: "desktop answer" }],
            stopReason: "stop",
            usage: { input_tokens: 1, output_tokens: 2 },
          });
        },
      },
      emitter: {
        emit: async (request) => { frames.push(request); },
        desktopStream: async (batch) => { batches.push(batch); },
        typing: async () => undefined,
      },
      systemPrompt: "test",
    });
    await runtime.start();
    await runtime.runTurn({
      ...job(),
      source: { platform: "desktop", chat_id: "s1", chat_type: "dm" },
      session_key: "agent:main:desktop:session:s1",
    }, handle());

    expect(batches.length).toBeGreaterThan(0);
    expect(batches.flatMap((batch) => batch.mutations).some((mutation) =>
      mutation.kind === "part_delta" && mutation.delta === "desktop answer")).toBe(true);
    const streamFrames = frames.filter((request) => request.emit_kind === "stream");
    expect(streamFrames).toHaveLength(1);
    expect(streamFrames[0]).toEqual(expect.objectContaining({
      state: "final",
      content: "desktop answer",
      seq: batches.at(-1)!.seq + 1,
    }));
    await runtime.stop();
  });

  test("keeps desktop tool paths local and includes successful live results", async () => {
    const artifact = "/private/var/artifacts/report.json";
    const streamFor = async (platform: string): Promise<{ detail: string; results: string[] }> => {
      const responses: AssistantMessage[] = [
        messageFixture({
          content: [{ type: "tool_call", id: "tool-1", name: "read", arguments: { path: artifact } }],
          stopReason: "toolUse",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        messageFixture({
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ];
      const tools = new ToolRegistry();
      tools.register({
        name: "read",
        description: "read a file",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
        execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
      });
      const emitted: EmitRequest[] = [];
      const runtime = new TypeScriptAgentRuntime({
        store: new MemoryStore(),
        tools,
        provider: { summarize, turn: async () => responses.shift()! },
        emitter: { emit: async (request) => { emitted.push(request); }, typing: async () => undefined },
        systemPrompt: "test",
        // The Feishu-owned default, which used to decide this for every platform.
        display: { model: "m", contextWindowTokens: 200_000, toolUseMode: "on", showFullPaths: false },
      });
      await runtime.start();
      await runtime.runTurn({
        ...job(),
        source: { platform, chat_id: "s1", chat_type: "dm" },
        session_key: `agent:main:${platform}:session:s1`,
      }, handle());
      await runtime.stop();
      const steps = emitted.flatMap((request) => request.tool_steps)
        .filter((item) => item?.name === "read");
      const details = new Set(steps.map((item) => String(item?.detail ?? "")));
      // Running and finished steps must agree, or the path changes under the
      // reader the moment the call completes.
      expect(details.size).toBe(1);
      return {
        detail: [...details][0]!,
        // Stream frames are cumulative, so the same finished step can appear
        // in both a delta and the terminal frame.
        results: [...new Set(steps.flatMap((item) => item?.result_block?.content ?? []))],
      };
    };

    // A card is read in a group chat by people who are not on this machine.
    expect(await streamFor("feishu")).toEqual({ detail: ".../report.json", results: [] });
    // The desktop window is this machine's own owner reading their own paths.
    const desktop = await streamFor("desktop");
    expect(desktop.detail).toBe(artifact);
    expect(desktop.results).toHaveLength(1);
    expect(desktop.results[0]).toContain("ok");
  });

  test("streams a CLI turn through the runtime emitter", async () => {
    const store = new MemoryStore();
    const emitted: EmitRequest[] = [];
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      provider: {
        summarize,
        turn: async (request) => {
          await request.onEvent?.(eventFixture("text_delta", "text-1", "cli answer"));
          return messageFixture({
            content: [{ type: "text", text: "cli answer" }],
            stopReason: "stop",
            usage: { input_tokens: 1, output_tokens: 2 },
          });
        },
      },
      emitter: { emit: async (request) => { emitted.push(request); }, typing: async () => undefined },
      systemPrompt: "test",
    });
    await runtime.start();
    await runtime.runTurn({
      ...job(),
      source: { platform: "cli", chat_id: "s1", chat_type: "local" },
      session_key: "agent:main:cli:session:s1",
    }, handle());

    expect(emitted.some((request) => request.emit_kind === "stream" && request.content === "cli answer"))
      .toBe(true);
    expect(store.metrics[0]).toMatchObject({ platform: "cli" });
    await runtime.stop();
  });

  test("persists tool state patches and records emitted files as artifacts", async () => {
    const responses: AssistantMessage[] = [
      messageFixture({
        content: [{ type: "tool_call", id: "tool-1", name: "bridge", arguments: {} }],
        stopReason: "toolUse",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      messageFixture({
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ];
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    tools.register({
      name: "bridge",
      description: "bridge",
      input_schema: { type: "object" },
      execute: async () => ({
        content: [{ type: "text", text: "created" }],
        state_patch: { browser: { session_id: "remote-1" } },
        files: ["/tmp/report.xlsx"],
      }),
    });
    const emitted: EmitRequest[] = [];
    const changes: string[] = [];
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools,
      provider: { summarize, turn: async () => responses.shift()! },
      emitter: { emit: async (request) => { emitted.push(request); }, typing: async () => undefined },
      onSessionChanged: async (_sessionId, change) => { changes.push(change); },
      systemPrompt: "test",
    });

    await runtime.start();
    await runtime.runTurn(job(), handle());

    expect(store.statePatches).toEqual([{ browser: { session_id: "remote-1" } }]);
    expect(emitted).toContainEqual(expect.objectContaining({
      session_id: "s1",
      response_route_id: "r1",
      emit_kind: "tool",
      files: ["/tmp/report.xlsx"],
    }));
    expect(store.artifacts).toEqual([
      expect.objectContaining({
        turn_id: "j1",
        tool_call_id: "tool-1",
        path: "/tmp/report.xlsx",
        name: "report.xlsx",
      }),
    ]);
    expect(changes).toContain("artifacts");
    await runtime.stop();
  });

  test("keeps a yielded tool visually running and passes its tool call id to the handler", async () => {
    const responses: AssistantMessage[] = [
      messageFixture({
        content: [{ type: "tool_call", id: "tool-exec-1", name: "exec", arguments: { command: "sleep" } }],
        stopReason: "toolUse",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      messageFixture({
        content: [{ type: "text", text: "detached" }],
        stopReason: "stop",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ];
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    let observedToolCallId = "";
    tools.register({
      name: "exec",
      description: "exec",
      input_schema: { type: "object" },
      execute: async (_input, executionContext) => {
        observedToolCallId = executionContext.tool_call_id ?? "";
        return {
          content: [{ type: "text", text: "status: running" }],
          display_status: "running",
        };
      },
    });
    const emitted: EmitRequest[] = [];
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools,
      provider: { summarize, turn: async () => responses.shift()! },
      emitter: { emit: async (request) => { emitted.push(request); }, typing: async () => undefined },
      systemPrompt: "test",
    });
    await runtime.start();
    await runtime.runTurn(job(), handle());
    expect(observedToolCallId).toBe("tool-exec-1");
    expect(JSON.stringify(store.messages)).not.toContain("display_status");
    const terminal = emitted.slice().reverse().find((request) => request.emit_kind === "stream");
    expect(terminal?.tool_steps).toContainEqual(expect.objectContaining({
      id: "tool-exec-1",
      status: "running",
    }));
    await runtime.stop();
  });

  test("records exactly one error result when tool file delivery fails", async () => {
    let secondRequestMessages: RuntimeMessage[] = [];
    let providerCalls = 0;
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    tools.register({
      name: "report",
      description: "report",
      input_schema: { type: "object" },
      execute: async () => ({ content: [{ type: "text", text: "created" }], files: ["/tmp/report.xlsx"] }),
    });
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools,
      provider: { summarize, turn: async (request) => {
        providerCalls += 1;
        if (providerCalls === 1) {
          return messageFixture({
            content: [{ type: "tool_call", id: "tool-1", name: "report", arguments: {} }],
            stopReason: "toolUse",
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        }
        secondRequestMessages = request.messages;
        return messageFixture({
          content: [{ type: "text", text: "delivery failed" }],
          stopReason: "stop",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      } },
      emitter: {
        emit: async (request) => {
          if (request.emit_kind === "tool") throw new Error("upload failed");
        },
        typing: async () => undefined,
      },
      systemPrompt: "test",
    });

    await runtime.start();
    await runtime.runTurn(job(), handle());

    expect(secondRequestMessages.at(-1)?.content).toEqual([
      expect.objectContaining({ type: "tool_result", tool_call_id: "tool-1", is_error: true }),
    ]);
    expect(store.artifacts).toEqual([]);
    await runtime.stop();
  });

  test("records each successfully delivered file before a later file fails", async () => {
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    tools.register({
      name: "reports",
      description: "reports",
      input_schema: { type: "object" },
      execute: async () => ({
        content: [{ type: "text", text: "created" }],
        files: ["/tmp/first.xlsx", "/tmp/first.xlsx", "/tmp/second.xlsx"],
      }),
    });
    let providerCalls = 0;
    const delivered: string[] = [];
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools,
      provider: { summarize, turn: async () => {
        providerCalls += 1;
        return providerCalls === 1 ? messageFixture({
          content: [{ type: "tool_call", id: "tool-1", name: "reports", arguments: {} }],
          stopReason: "toolUse",
          usage: { input_tokens: 1, output_tokens: 1 },
        }) : messageFixture({
          content: [{ type: "text", text: "partial delivery reported" }],
          stopReason: "stop",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      } },
      emitter: {
        emit: async (request) => {
          if (request.emit_kind !== "tool") return;
          const path = request.files[0]!;
          delivered.push(path);
          if (path.endsWith("second.xlsx")) throw new Error("second upload failed");
        },
        typing: async () => undefined,
      },
      systemPrompt: "test",
    });

    await runtime.start();
    await runtime.runTurn(job(), handle());

    expect(delivered).toEqual(["/tmp/first.xlsx", "/tmp/second.xlsx"]);
    expect(store.artifacts).toEqual([
      expect.objectContaining({ path: "/tmp/first.xlsx", tool_call_id: "tool-1" }),
    ]);
    await runtime.stop();
  });

  test("stops stream retries after the first delivery failure and preserves the completed turn", async () => {
    const store = new MemoryStore();
    const logLines: string[] = [];
    let streamAttempts = 0;
    let finalAttempts = 0;
    let providerCalls = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "noop",
      description: "noop",
      input_schema: { type: "object" },
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools,
      provider: { summarize, turn: async (request) => {
        providerCalls += 1;
        await request.onEvent?.(eventFixture("text_delta", "text-1", "d"));
        await request.onEvent?.(eventFixture("text_delta", "text-1", "o"));
        if (providerCalls === 1) {
          return messageFixture({
            content: [{ type: "tool_call", id: "tool-1", name: "noop", arguments: {} }],
            stopReason: "toolUse",
            usage: { input_tokens: 2, output_tokens: 1 },
          });
        }
        await request.onEvent?.(eventFixture("text_delta", "text-1", "ne"));
        return messageFixture({
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
          usage: { input_tokens: 4, output_tokens: 1 },
        });
      } },
      emitter: {
        emit: async (request) => {
          if (request.emit_kind === "stream") streamAttempts += 1;
          if (request.emit_kind === "final") finalAttempts += 1;
          throw new Error("delivery offline");
        },
        typing: async () => undefined,
      },
      systemPrompt: "test",
      logger: createLogger("test.runtime", { write: (line) => logLines.push(line) }),
    });

    await runtime.start();
    const outcome = await runtime.runTurn(job(), handle());

    expect(outcome).toEqual(expect.objectContaining({ status: "completed", reply: "done" }));
    expect(streamAttempts).toBe(1);
    expect(finalAttempts).toBe(1);
    expect(store.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    });
    const records = logLines.map((line) => JSON.parse(line));
    expect(records.filter((record) => record.message === "stream_fallback_started")).toHaveLength(1);
    expect(records.filter((record) => record.message === "stream_fallback_failed")).toHaveLength(1);
    expect(records.filter((record) => record.message === "outbound delivery failed" && record.phase === "final"))
      .toHaveLength(0);
    await runtime.stop();
  });

  test("returns an error outcome when both the provider and error reply delivery fail", async () => {
    const store = new MemoryStore();
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      provider: { summarize, turn: async () => { throw new Error("provider offline"); } },
      emitter: {
        emit: async () => { throw new Error("delivery offline"); },
        typing: async () => undefined,
      },
      systemPrompt: "test",
    });

    await runtime.start();
    const outcome = await runtime.runTurn(job(), handle());

    expect(outcome).toEqual(expect.objectContaining({
      status: "error",
      reply: "执行失败: provider offline",
    }));
    expect(store.turnErrors).toEqual([{ turn_id: "j1", message: "执行失败: provider offline" }]);
    expect(store.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(store.metrics.at(-1)).toEqual(expect.objectContaining({ status: "error" }));
    await runtime.stop();
  });

  test("keeps a successful turn independent from typing delivery", async () => {
    const store = new MemoryStore();
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      provider: { summarize, turn: async () => (messageFixture({
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: { input_tokens: 1, output_tokens: 1 },
      })) },
      emitter: {
        emit: async () => undefined,
        typing: async () => { throw new Error("typing unavailable"); },
      },
      systemPrompt: "test",
    });

    await runtime.start();
    const outcome = await runtime.runTurn(job(), handle());

    expect(outcome).toEqual(expect.objectContaining({ status: "completed", reply: "done" }));
    await runtime.stop();
  });

  test("forces one compaction and retries once after provider context overflow", async () => {
    const store = new MemoryStore();
    store.messages = [
      ...["old-1", "old-2", "old-3"].flatMap((label): RuntimeMessage[] => [
        { role: "user", content: `${label} request ${"u".repeat(24_000)}` },
        { role: "assistant", content: [{ type: "text", text: `${label} answer ${"a".repeat(24_000)}` }] },
      ]),
    ];
    let providerCalls = 0;
    let summaryCalls = 0;
    let retriedMessages: RuntimeMessage[] = [];
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      contextWindowTokens: 100_000,
      provider: {
        summarize: async () => {
          summaryCalls += 1;
          return { text: "preserved old decision", usage: { input_tokens: 20, output_tokens: 5 } };
        },
        turn: async (request) => {
          providerCalls += 1;
          if (providerCalls === 1) throw new Error("maximum context length exceeded");
          retriedMessages = request.messages;
          return messageFixture({
            content: [{ type: "text", text: "recovered" }],
            stopReason: "stop",
            usage: { input_tokens: 10, output_tokens: 2 },
          });
        },
      },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
    });
    await runtime.start();
    const outcome = await runtime.runTurn(job(), handle());
    expect(outcome).toEqual(expect.objectContaining({ status: "completed", reply: "recovered" }));
    expect(providerCalls).toBe(2);
    expect(summaryCalls).toBe(1);
    expect(JSON.stringify(retriedMessages)).toContain("preserved old decision");
    expect(store.replacements.some((messages) => JSON.stringify(messages).includes("preserved old decision"))).toBe(true);
    expect(store.metrics.at(-1)).toEqual(expect.objectContaining({ api_calls: 3, input_tokens: 30, output_tokens: 7 }));
    await runtime.stop();
  });

  test("fails explicitly without replacing history when summaries stay empty over the hard limit", async () => {
    const store = new MemoryStore();
    store.messages = ["old-1", "old-2", "old-3"].flatMap((label): RuntimeMessage[] => [
      { role: "user", content: `${label} request ${"x".repeat(24_000)}` },
      { role: "assistant", content: [{ type: "text", text: `${label} answer ${"y".repeat(24_000)}` }] },
    ]);
    let providerCalls = 0;
    let summaryCalls = 0;
    const original = structuredClone(store.messages);
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      contextWindowTokens: 1_000,
      provider: {
        summarize: async () => {
          summaryCalls += 1;
          return { text: "", usage: { input_tokens: 2, output_tokens: 0 } };
        },
        turn: async () => {
          providerCalls += 1;
          throw new Error("turn must not be called");
        },
      },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
    });
    await runtime.start();
    const outcome = await runtime.runTurn(job(), handle());
    expect(outcome.status).toBe("error");
    expect(outcome.reply).toContain("无法安全完成压缩");
    expect(summaryCalls).toBe(4);
    expect(providerCalls).toBe(0);
    expect(store.replacements).toHaveLength(0);
    expect(store.messages.slice(0, original.length)).toEqual(original);
    await runtime.stop();
  }, 20_000);

  test("stops explicitly at the soft threshold when summarization fails", async () => {
    const store = new MemoryStore();
    store.messages = [
      { role: "user", content: `old request ${"x".repeat(464_000)}` },
      { role: "assistant", content: [{ type: "text", text: `old answer ${"y".repeat(464_000)}` }] },
      { role: "user", content: "recent request" },
      { role: "assistant", content: [{ type: "text", text: "recent answer" }] },
    ];
    let providerCalls = 0;
    let summaryCalls = 0;
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      contextWindowTokens: 256_000,
      provider: {
        summarize: async () => {
          summaryCalls += 1;
          throw new Error("summary offline");
        },
        turn: async () => {
          providerCalls += 1;
          throw new Error("turn must not be called");
        },
      },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
    });
    await runtime.start();
    const outcome = await runtime.runTurn(job(), handle());
    expect(outcome.status).toBe("error");
    expect(outcome.reply).toContain("无法安全完成压缩");
    expect(summaryCalls).toBe(1);
    expect(providerCalls).toBe(0);
    expect(store.replacements).toHaveLength(0);
    expect(store.metrics.at(-1)).toEqual(expect.objectContaining({ api_calls: 1 }));
    await runtime.stop();
  });

  test("ages processed history images after a completed turn", async () => {
    const store = new MemoryStore();
    store.messages = [{
      role: "user",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "secret-base64" } }],
    }];
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      provider: { summarize, turn: async () => (messageFixture({
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: { input_tokens: 1, output_tokens: 1 },
      })) },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
    });
    await runtime.start();
    const outcome = await runtime.runTurn(job(), handle());
    expect(outcome.status).toBe("completed");
    expect(JSON.stringify(store.messages)).toContain("already processed");
    expect(JSON.stringify(store.messages)).not.toContain("secret-base64");
    await runtime.stop();
  });

  test("closes remaining tool calls when cancellation arrives between dispatches", async () => {
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    const controller = new AbortController();
    const runHandle: RuntimeHandle = {
      signal: controller.signal,
      cancelled: false,
      drainSteering: () => [],
      registerProcess: () => () => undefined,
    };
    tools.register({
      name: "first", description: "first", input_schema: { type: "object", properties: {} },
      execute: async () => {
        controller.abort(new DOMException("Aborted", "AbortError"));
        return { content: [{ type: "text", text: "first completed" }] };
      },
    });
    tools.register({
      name: "second", description: "second", input_schema: { type: "object", properties: {} },
      execute: async () => { throw new Error("must not run"); },
    });
    const runtime = new TypeScriptAgentRuntime({
      store, tools,
      provider: { summarize, turn: async () => (messageFixture({
        content: [
          { type: "tool_call", id: "t1", name: "first", arguments: {} },
          { type: "tool_call", id: "t2", name: "second", arguments: {} },
        ],
        stopReason: "toolUse", usage: { input_tokens: 1, output_tokens: 1 },
      })) },
      emitter: { emit: async () => undefined, typing: async () => undefined }, systemPrompt: "test",
    });
    await runtime.start();
    const outcome = await runtime.runTurn(job(), runHandle);
    expect(outcome.status).toBe("cancelled");
    expect(store.messages.at(-1)?.content).toEqual([
      expect.objectContaining({ type: "tool_result", tool_call_id: "t1" }),
      expect.objectContaining({ type: "tool_result", tool_call_id: "t2", is_error: true }),
    ]);
    await runtime.stop();
  });

  test("consumes steering before tool dispatch and asks the provider to reconsider", async () => {
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    let toolCalls = 0;
    let providerCalls = 0;
    let drains = 0;
    tools.register({
      name: "dangerous", description: "dangerous", input_schema: { type: "object", properties: {} },
      execute: async () => { toolCalls += 1; return { content: [] }; },
    });
    const runHandle: RuntimeHandle = {
      signal: new AbortController().signal,
      cancelled: false,
      drainSteering: () => {
        drains += 1;
        return drains === 2 ? [{ text: "不要执行，改为解释" }] : [];
      },
      registerProcess: () => () => undefined,
    };
    const runtime = new TypeScriptAgentRuntime({
      store, tools,
      provider: { summarize, turn: async () => {
        providerCalls += 1;
        return providerCalls === 1
          ? messageFixture({ content: [{ type: "tool_call", id: "t1", name: "dangerous", arguments: {} }], stopReason: "toolUse", usage: { input_tokens: 1, output_tokens: 1 } })
          : messageFixture({ content: [{ type: "text", text: "已改为解释" }], stopReason: "stop", usage: { input_tokens: 1, output_tokens: 1 } });
      } },
      emitter: { emit: async () => undefined, typing: async () => undefined }, systemPrompt: "test",
    });
    await runtime.start();
    const outcome = await runtime.runTurn(job(), runHandle);
    expect(outcome).toEqual(expect.objectContaining({ status: "completed", reply: "已改为解释" }));
    expect(toolCalls).toBe(0);
    expect(JSON.stringify(store.messages)).toContain("skipped because the user steered");
    expect(JSON.stringify(store.messages)).toContain("不要执行");
    await runtime.stop();
  });

  test("returns the compatible continuation message at the step limit", async () => {
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    tools.register({
      name: "loop", description: "loop", input_schema: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "again" }] }),
    });
    const runtime = new TypeScriptAgentRuntime({
      store, tools, maxSteps: 1,
      provider: { summarize, turn: async () => (messageFixture({
        content: [{ type: "tool_call", id: "t1", name: "loop", arguments: {} }],
        stopReason: "toolUse", usage: { input_tokens: 1, output_tokens: 1 },
      })) },
      emitter: { emit: async () => undefined, typing: async () => undefined }, systemPrompt: "test",
    });
    await runtime.start();
    const outcome = await runtime.runTurn(job(), handle());
    expect(outcome).toEqual(expect.objectContaining({
      status: "completed", reply: "本轮已达到最大步骤，请发送下一条消息继续。",
    }));
    expect(store.messages.at(-1)).toMatchObject({
      role: "assistant", content: [{ type: "text", text: "本轮已达到最大步骤，请发送下一条消息继续。" }],
    });
    await runtime.stop();
  });

  test("retries retryable provider errors three times but stops non-retryable errors immediately", async () => {
    const run = async (retryable: boolean): Promise<{
      calls: number;
      contexts: number;
      snapshots: number;
      turnErrors: Array<{ turn_id: string; message: string }>;
      outcome: Awaited<ReturnType<TypeScriptAgentRuntime["runTurn"]>>;
    }> => {
      const store = new MemoryStore();
      let calls = 0;
      let snapshots = 0;
      const runtime = new TypeScriptAgentRuntime({
        store, tools: new ToolRegistry(),
        skillSnapshot: () => {
          snapshots += 1;
          return { names: [], prompt: "", modules: {} };
        },
        provider: {
          summarize,
          turn: async () => {
            calls += 1;
            throw new RuntimeProviderError(
              retryable ? "service unavailable" : "invalid authentication",
              "kimi_coding",
              retryable ? "服务暂时异常" : "认证错误",
              retryable ? "Kimi Coding 服务暂时异常，请稍后重试。" : "Kimi Coding 认证失败，请检查 API Key。",
              retryable,
              retryable ? 503 : 401,
            );
          },
        },
        emitter: { emit: async () => undefined, typing: async () => undefined }, systemPrompt: "test",
      });
      await runtime.start();
      const outcome = await runtime.runTurn(job(), handle());
      await runtime.stop();
      return { calls, contexts: store.turnContexts.length, snapshots, turnErrors: store.turnErrors, outcome };
    };
    const retryable = await run(true);
    expect(retryable.calls).toBe(3);
    expect(retryable.contexts).toBe(1);
    expect(retryable.snapshots).toBe(1);
    expect(retryable.outcome.reply).toBe("执行失败: Kimi Coding 服务暂时异常，请稍后重试。");
    expect(retryable.turnErrors).toEqual([{ turn_id: "j1", message: retryable.outcome.reply }]);
    const fatal = await run(false);
    expect(fatal.calls).toBe(1);
    expect(fatal.contexts).toBe(1);
    expect(fatal.snapshots).toBe(1);
    expect(fatal.outcome.reply).toBe("执行失败: Kimi Coding 认证失败，请检查 API Key。");
  });

  test("reports a cloud authentication failure once and blocks the invalid revision on later turns", async () => {
    const store = new MemoryStore();
    const revision = "d".repeat(64);
    const environment: Record<string, string> = {
      LXE_MANAGED_LLM_INVALID_REVISION: "",
    };
    let calls = 0;
    const failures: string[] = [];
    const snapshot: RuntimeProviderSnapshot = {
      generation: 1,
      descriptor: {
        name: "deepseek",
        model: "deepseek-v4-flash",
        apiStyle: "anthropic_messages",
        credentialSource: "cloud",
        credentialRevision: revision,
        baseURL: "https://api.deepseek.test",
        apiKey: "managed-secret",
        maxTokens: 4_096,
        defaultHeaders: {},
        thinkingStyle: "provider-managed",
        thinkingLevels: ["off", "low", "high", "max"],
        thinkingDefault: "low",
        thinkingEnabled: true,
        thinkingEffort: "low",
        thinkingDisplay: "omitted",
        contextWindowTokens: 1_000_000,
        requestIdleTimeoutMs: 1_000,
      },
      provider: {
        summarize,
        turn: async () => {
          calls += 1;
          throw new RuntimeProviderError(
            "invalid authentication",
            "deepseek",
            "认证失败",
            "DeepSeek 认证失败，请检查 API Key 是否正确。",
            false,
            401,
          );
        },
      },
    };
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      providerManager: { acquire: () => snapshot, reconfigure: async () => snapshot },
      environment,
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
      onManagedLlmAuthenticationFailure: (_provider, _model, failedRevision) => {
        failures.push(failedRevision);
        environment.LXE_MANAGED_LLM_INVALID_REVISION = failedRevision;
      },
    });
    await runtime.start();
    expect((await runtime.runTurn(job(), handle())).status).toBe("error");
    expect((await runtime.runTurn({
      ...job(), job_id: "j2", message_id: "m2",
    }, handle())).status).toBe("error");
    await runtime.stop();

    expect(calls).toBe(1);
    expect(failures).toEqual([revision]);
  });

  test("does not invalidate a cloud credential for permission-shaped 401 errors", async () => {
    const store = new MemoryStore();
    const revision = "e".repeat(64);
    const failures: string[] = [];
    const snapshot: RuntimeProviderSnapshot = {
      generation: 1,
      descriptor: {
        name: "deepseek",
        model: "deepseek-v4-flash",
        apiStyle: "anthropic_messages",
        credentialSource: "cloud",
        credentialRevision: revision,
        baseURL: "https://api.deepseek.test",
        apiKey: "managed-secret",
        maxTokens: 4_096,
        defaultHeaders: {},
        thinkingStyle: "provider-managed",
        thinkingLevels: ["off", "low", "high", "max"],
        thinkingDefault: "low",
        thinkingEnabled: true,
        thinkingEffort: "low",
        thinkingDisplay: "omitted",
        contextWindowTokens: 1_000_000,
        requestIdleTimeoutMs: 1_000,
      },
      provider: {
        summarize,
        turn: async () => {
          throw new RuntimeProviderError(
            "model access denied",
            "deepseek",
            "权限错误",
            "DeepSeek 当前账号无权使用该模型。",
            false,
            401,
          );
        },
      },
    };
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      providerManager: { acquire: () => snapshot, reconfigure: async () => snapshot },
      environment: { LXE_MANAGED_LLM_INVALID_REVISION: "" },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
      onManagedLlmAuthenticationFailure: (_provider, _model, failedRevision) => {
        failures.push(failedRevision);
      },
    });
    await runtime.start();
    expect((await runtime.runTurn(job(), handle())).status).toBe("error");
    await runtime.stop();

    expect(failures).toEqual([]);
  });

  test("creates distinct zero-based wire attempts for retries and later agent steps", async () => {
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "echo",
      input_schema: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
    const attempts: Array<{ step: number; attempt: number }> = [];
    let calls = 0;
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools,
      provider: {
        summarize,
        turn: async () => {
          calls += 1;
          if (calls === 1) {
            throw new RuntimeProviderError("retry", "custom", "temporary", "retry", true, 503);
          }
          if (calls === 2) {
            return messageFixture({
              content: [{ type: "tool_call", id: "tool-1", name: "echo", arguments: {} }],
              stopReason: "toolUse",
              usage: { input_tokens: 1, output_tokens: 1 },
            });
          }
          return messageFixture({
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        },
      },
      wireTraceController: {
        startTurn: () => ({
          startProviderAttempt: (context) => {
            attempts.push({ step: context.step, attempt: context.attempt });
            return {
              requestStart: () => undefined,
              responseStart: () => undefined,
              event: () => undefined,
              parseError: () => undefined,
              end: () => undefined,
            };
          },
        }),
      },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
    });
    await runtime.start();
    const outcome = await runtime.runTurn(job(), handle());
    expect(outcome).toEqual(expect.objectContaining({ status: "completed", reply: "done" }));
    expect(attempts).toEqual([
      { step: 0, attempt: 1 },
      { step: 0, attempt: 2 },
      { step: 1, attempt: 1 },
    ]);
    await runtime.stop();
  });
});

test("accounts failed attempts once and isolates their streamed text from the retry", async () => {
  const store = new MemoryStore();
  const emitted: EmitRequest[] = [];
  const messageIds: string[] = [];
  let calls = 0;
  const runtime = new TypeScriptAgentRuntime({
    store, tools: new ToolRegistry(), systemPrompt: "test",
    provider: { summarize, turn: async (request) => {
      const { AssistantMessageAccumulator } = await import("../../src/messages/accumulator");
      const a = new AssistantMessageAccumulator({ name: "test", model: "test", apiStyle: "openai_completions" }, request.onEvent);
      messageIds.push(a.message.id);
      const textIndex = a.startText();
      calls++;
      a.append(textIndex, calls === 1 ? "failed prefix" : "good answer");
      a.usage({ input_tokens: calls === 1 ? 3 : 5, output_tokens: 2, status: "partial" });
      if (calls === 1) {
        const error = new RuntimeProviderError("connection reset", "test", "transport", "connection reset", true);
        a.fail("error", error); await a.drain(); throw error;
      }
      a.usage({ status: "complete" });
      const result = a.complete("stop"); await a.drain(); return result;
    } },
    emitter: { emit: async (value) => { emitted.push(value); }, typing: async () => undefined },
  });
  await runtime.start();
  const result = await runtime.runTurn(job(), handle());
  await runtime.stop();
  expect(result).toMatchObject({ status: "completed", reply: "good answer", input_tokens: 8, output_tokens: 4 });
  expect(calls).toBe(2);
  expect(new Set(messageIds).size).toBe(2);
  expect(store.metrics[0]).toMatchObject({ input_tokens: 8, output_tokens: 4, api_calls: 2 });
  expect(store.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  const terminal = emitted.filter((e) => e.emit_kind === "stream" && e.state === "final").at(-1);
  expect(terminal?.content).toBe("good answer");
  if (terminal?.emit_kind !== "stream") throw new Error("Missing terminal stream");
  expect(terminal.process_parts.filter((p) => p.type === "text").map((p) => p.status)).toEqual(["error", "completed"]);
});

test("does not execute or synthesize results for truncated tool drafts", async () => {
  const store = new MemoryStore();
  const tools = new ToolRegistry();
  let executions = 0;
  tools.register({ name: "dangerous", description: "test", input_schema: { type: "object" }, execute: async () => { executions++; return { content: [] }; } });
  const runtime = new TypeScriptAgentRuntime({
    store, tools, systemPrompt: "test",
    provider: { summarize, turn: async () => messageFixture({ stopReason: "length", content: [
      { type: "text", text: "partial answer" }, { type: "tool_call", id: "call", name: "dangerous" },
    ] }) },
    emitter: { emit: async () => undefined, typing: async () => undefined },
  });
  await runtime.start();
  const result = await runtime.runTurn(job(), handle());
  await runtime.stop();
  expect(result).toMatchObject({ status: "completed", reply: "partial answer" });
  expect(executions).toBe(0);
  expect(store.messages.some((m) => m.role === "tool")).toBe(false);
});

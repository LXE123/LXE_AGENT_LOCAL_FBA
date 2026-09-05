import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, SYSTEM_PROMPT_CACHE_BREAKPOINT } from "../../src/engine/system-prompt";

describe("system prompt builder", () => {
  test("keeps stable policy before the cache boundary and runtime context after it", () => {
    const prompt = buildSystemPrompt({
      soul: "Careful agent.",
      platform: "feishu",
      provider: "anthropic",
      model: "claude-test",
      skillPrompt: "## Available Skills\n- one",
      workspaceInstructions: "## Workspace Instructions\nFollow the project rules.",
      workspace: {
        directory: "/workspace/project",
        worktree: "/workspace",
      },
    });
    const [stable, volatile] = prompt.split(SYSTEM_PROMPT_CACHE_BREAKPOINT);
    expect(stable).toContain("Careful agent.");
    expect(stable).toContain("Safety & Boundaries");
    expect(stable).toContain("Attachment Handling");
    expect(stable).toContain("cause_known=true");
    expect(stable).toContain("preserve the actual observed error");
    expect(stable).toContain("tested mapping_id");
    expect(volatile).toContain("Available Skills");
    expect(volatile).toContain("Follow the project rules.");
    expect(volatile).not.toContain("Provider: anthropic");
    expect(volatile).not.toContain("Model: claude-test");
    expect(volatile).not.toContain("Platform: feishu");
    expect(volatile).not.toContain("Working directory: /workspace/project");
    expect(volatile).not.toContain("Git worktree root: /workspace");
    expect(volatile).toContain("There is no filesystem or network sandbox");
    expect(volatile).toContain("workspace is only the default path base");
    expect(volatile).not.toContain(`Server ${"scope"}`);
  });

  test("caches the dataset map without embedding the absolute root", () => {
    const prompt = buildSystemPrompt({
      platform: "feishu",
      provider: "anthropic",
      model: "claude-test",
      skillPrompt: "",
      workspace: { directory: "/workspace/project", worktree: "/workspace" },
      datasets: [
        { id: "fba_delivery_csv", dir: "fba/delivery_csv", holds: "FBA 发货单 CSV。" },
        { id: "replenish_store_msku", dir: "replenish/store_msku", holds: "店铺 MSKU 数据。" },
      ],
      artifactRoot: "/data/var/artifacts",
    });
    const [stable, volatile] = prompt.split(SYSTEM_PROMPT_CACHE_BREAKPOINT);
    // The map never changes between turns, so it must sit inside the cached prefix.
    expect(stable).toContain("## Data Directories");
    expect(stable).toContain("fba/delivery_csv — FBA 发货单 CSV。");
    expect(stable).toContain("### replenish");
    expect(stable).not.toContain("/data/var/artifacts");
    // The root is supplied by environment context.
    expect(volatile).not.toContain("Artifact root: /data/var/artifacts");
    expect(volatile).not.toContain("## Data Directories");
  });

  test("omits the dataset section entirely when no registry is supplied", () => {
    const prompt = buildSystemPrompt({
      platform: "feishu",
      provider: "anthropic",
      model: "claude-test",
      skillPrompt: "",
      workspace: { directory: "/workspace/project", worktree: "/workspace" },
    });
    expect(prompt).not.toContain("## Data Directories");
    expect(prompt).not.toContain("Artifact root:");
  });
});

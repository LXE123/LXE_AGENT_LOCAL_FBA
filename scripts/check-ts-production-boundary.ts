import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const failures: string[] = [];
const repositoryFiles = (pathspec: string): string[] => {
  const result = Bun.spawnSync([
    "git",
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    pathspec,
  ], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).split("\0").filter(Boolean);
};
const requireText = (path: string, pattern: RegExp, message: string): void => {
  if (!pattern.test(read(path))) failures.push(`${path}: ${message}`);
};
const forbidText = (path: string, pattern: RegExp, message: string): void => {
  if (pattern.test(read(path))) failures.push(`${path}: ${message}`);
};
const forbidPath = (path: string, message: string): void => {
  if (existsSync(join(root, path))) failures.push(`${path}: ${message}`);
};
const requirePath = (path: string, message: string): void => {
  if (!existsSync(join(root, path))) failures.push(`${path}: ${message}`);
};
const manifestDependencies = (path: string): Record<string, string> => {
  const manifest = JSON.parse(read(path)) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  return {
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
    ...(manifest.peerDependencies ?? {}),
  };
};
const forbidDependency = (path: string, dependency: string, message: string): void => {
  if (dependency in manifestDependencies(path)) failures.push(`${path}: ${message}`);
};

forbidText("package.json", /main\.py|agent_runtime\.worker/, "workspace scripts must not start Python production code");
forbidText("package.json", /gateway:(?:dev|watch|start|stop|build)/, "workspace must not expose a standalone Gateway CLI");
forbidText("apps/gateway/package.json", /"(?:dev|watch|start|stop|build)"\s*:/, "Gateway package must be a desktop library only");
forbidPath("config/runtime.env", "runtime defaults must be owned by code and settings.json");
forbidPath(".env.local.example", "local preferences must be stored in settings.json");
forbidText("apps/dashboard/src/api/client.ts", /\bfetch\b|VITE_API_BASE_URL|HttpDashboardTransport/, "Renderer API must use Electron IPC only");
forbidText("apps/dashboard/src/api/queries.ts", /\/api\/|URLSearchParams|encodeURIComponent/, "Renderer queries must send typed Dashboard RPC inputs");
forbidText("apps/agent-cli/src/dashboard-service.ts", /\bRequest\b|\bResponse\b|Response\.json|request\.json|new URL/, "Dashboard service must not emulate HTTP");
forbidText("apps/agent-cli/src/runtime-host.ts", /dashboard_request|new Request|new URL|response\.status/, "Agent host must forward typed Dashboard RPC calls directly");
forbidText("apps/desktop/src/main/ipc-validation.ts", /\/api\/|GET_PATHS|PATCH_PATHS/, "Desktop IPC must validate Dashboard operations instead of paths");
forbidText("packages/foundation/desktop-protocol/src/index.ts", /dashboard_request|DashboardRequestPayload/, "agent protocol must not expose the retired pseudo-REST command");
requireText("packages/foundation/desktop-protocol/src/index.ts", /AGENT_PROTOCOL_VERSION\s*=\s*18\s+as const/, "agent protocol must use the JSON-RPC v18 business contract");
forbidText("packages/foundation/desktop-protocol/src/index.ts", /runtime_env_path/, "agent protocol must not expose a dotenv path");
requireText("packages/foundation/desktop-protocol/src/index.ts", /type:\s*"session\.changed"/, "agent protocol must expose persisted session changes");
forbidText("apps/desktop/src/main/dashboard-invalidation.ts", /item\.completed/, "outbound item events must not invalidate Dashboard session data");
forbidText("apps/dashboard/src/api/queries.ts", /ACTIVE_DATA_REFRESH_INTERVAL_MS/, "session queries must remain push-driven instead of restoring shared polling");
forbidText("apps/gateway/src/channels/feishu/cardkit.ts", /queues\s*=\s*new Map<string, Promise<void>>/, "CardKit full snapshots must not be restored to a per-frame Promise FIFO");
requireText("apps/gateway/src/channels/feishu/cardkit.ts", /card_frame_coalesced/, "CardKit must retain observable latest-frame coalescing");
forbidText("packages/foundation/desktop-protocol/src/index.ts", /remaining_steering\?\s*:/, "run_turn must always report remaining steering");
forbidText("apps/gateway/src/orchestration/composition.ts", /remaining_steering\s*\?\?/, "Gateway must not default a missing steering handoff to an empty list");
forbidText("apps/gateway/src/orchestration/composition.ts", /\blet\s+runtimeReady\b/, "Gateway composition must read readiness from the Runtime port");
forbidText("apps/desktop/src/main/desktop-gateway.ts", /parts\.scheduler\.setRuntimeReady/, "Desktop must synchronize Runtime readiness through the Gateway composition boundary");
forbidText("packages/agent/runtime/src/engine/system-events.ts", /mergePendingSystemEvents/, "Runtime must not restore the retired embedded/stored pending-event merge");
forbidText("packages/agent/runtime/src/engine/runtime.ts", /job\.raw_data\.system_events/, "Runtime pending events must come only from its Store");
requireText("apps/desktop/src/main.ts", /registerDashboardProtocol/, "packaged Renderer must load through the Electron app protocol");
requireText("package.json", /"desktop:preview"\s*:\s*"[^\"]*bun run dashboard:build && bun run --cwd apps\/desktop preview"/, "workspace must expose the production Renderer preview");
requireText("package.json", /"desktop:pack:win"\s*:\s*"[^"]*-PackageTarget Unpacked"/, "workspace must expose the Windows unpacked verification route");
requireText("package.json", /"verify:platform:win"\s*:\s*"[^"]*desktop:dist:win"/, "Windows release verification must retain the complete NSIS route");
requireText("apps/desktop/package.json", /"preview"\s*:\s*"bun run build && bun src\/preview\.ts"/, "desktop package must build Main and Preload before preview");
requireText("apps/desktop/package.json", /"pack:win"\s*:\s*"electron-builder [^"]*--dir --x64 [^"]*dist\/desktop-unpacked"/, "desktop package must keep unpacked output separate from release artifacts");
requireText("apps/desktop/src/preview.ts", /LXE_DESKTOP_PREVIEW\s*=\s*"1"/, "preview launcher must select the internal preview mode");
requireText("apps/desktop/src/preview.ts", /delete environment\.LXE_DATA_ROOT/, "preview launcher must discard external desktop data roots");
requireText("apps/desktop/src/dev.ts", /delete desktopEnvironment\.LXE_DATA_ROOT/, "development launcher must discard external desktop data roots");
requireText("apps/desktop/src/main/paths.ts", /targetPath\.join\(projectRoot, "var"\)/, "desktop state must use the project-local var root");
forbidText("apps/desktop/src/main/paths.ts", /environment\.LXE_DATA_ROOT|userDataPath/, "desktop state roots must not fall back to external application data");
for (const pathName of ["userData", "sessionData", "temp", "logs", "crashDumps"]) {
  requireText(
    "apps/desktop/src/main/runtime-state.ts",
    new RegExp(`setPath\\(\\"${pathName}\\"`),
    `Electron ${pathName} must be routed into the project var root`,
  );
}
forbidText("apps/desktop/src/preview.ts", /https?:\/\/|\bfetch\b|VITE|5173|8765|LXE_DASHBOARD_DEV_URL\s*=/, "production preview must not start or target an HTTP Renderer");
requireText("apps/desktop/src/main.ts", /usesProductionRenderer\(launchMode\)/, "desktop must select the Renderer independently from packaging");
requireText("apps/desktop/src/main.ts", /usesPackagedRuntime\(launchMode\)/, "desktop must keep preview on the source Runtime");
requireText("apps/desktop/src/main/desktop-gateway.ts", /sourceEnvironment:\s*\{ \.\.\.configuredEnvironment, \.\.\.processEnvironment \}/, "source development and Preview must use the resolved settings environment");
requireText("apps/desktop/src/main/desktop-gateway.ts", /managedEnvironment:\s*configuredEnvironment/, "packaged Desktop must use the managed Data Server environment");
requireText("apps/desktop/src/main/desktop-gateway.ts", /withoutDataServerEnvironment\(configuredEnvironment\)/, "Gateway must remove inherited Data Server values before applying its mode policy");
requireText("apps/desktop/src/main/desktop-gateway.ts", /machineIdentityPath:\s*join\(this\.options\.paths\.dataRoot, "db", "machine_identity\.json"\)/, "Data Server machine identity must remain under the canonical var root");
requireText("apps/desktop/src/main/desktop-gateway.ts", /allowedSkillTypes:\s*\(\)\s*=>\s*readonly string\[\]/, "Desktop Runtime Skill visibility must come from the device permission snapshot");
forbidText("apps/desktop/src/main/desktop-gateway.ts", /botSkillPolicy|permissionPolicy|LXE_PERMISSION_POLICY_PATH/, "Desktop Runtime must not retain the retired Feishu permission policy");
requirePath("apps/gateway/src/channels/feishu/adapter.ts", "Feishu remote ingress must remain available");
forbidPath("config/permission_policy.yaml", "the retired Feishu Bot and union-id policy must stay deleted");
forbidPath("apps/gateway/src/security/permission-policy.ts", "the retired Gateway permission-policy loader must stay deleted");
forbidPath("python/lxeskill_cli/shared/permission_policy_loader.py", "the retired Python permission-policy loader must stay deleted");
forbidPath("scripts/permission_policy_admin.py", "the retired permission-policy admin tool must stay deleted");
forbidText("packages/foundation/desktop-protocol/src/index.ts", /permission_policy_path/, "Agent protocol must not carry the retired permission-policy path");
const retiredFeishuAuthorizationPatterns = [
  /botSkillPolicy|PermissionPolicy|permission[_-]?policy[_-]?path|LXE_PERMISSION_POLICY_PATH/i,
  /(?:bot[_-]?(?:id|app[_-]?id)|botId|botAppId|union[_-]?id|unionId).{0,80}(?:allowlist|whitelist|allowed[_-]?users|skill[_-]?types|skillTypes)/is,
  /(?:allowlist|whitelist|allowed[_-]?users|skill[_-]?types|skillTypes).{0,80}(?:bot[_-]?(?:id|app[_-]?id)|botId|botAppId|union[_-]?id|unionId)/is,
] as const;
for (const pattern of ["apps/**/src/**/*.ts", "packages/**/src/**/*.ts", "python/lxeskill_cli/**/*.py", "config/**/*.{json,yaml,yml}"]) {
  for await (const path of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
    for (const retired of retiredFeishuAuthorizationPatterns) {
      if (retired.test(read(path))) failures.push(`${path}: Feishu Bot and union-id identities must not authorize local Skills or users`);
    }
  }
}
requireText("scripts/install.sh", /REF="lxe-agent-TUI"/, "legacy shell installer must forward to the TUI product line");
requireText("scripts/install.ps1", /\$Ref\s*=\s*"lxe-agent-TUI"/, "legacy PowerShell installer must forward to the TUI product line");
forbidText("apps/agent-cli/src/dashboard-service.ts", /\.env\.local|persistEnvironment/, "Agent Dashboard must not persist dotenv files");
requireText("apps/desktop/src/main/config-store/repository.ts", /"settings\.json"/, "Desktop configuration must persist to settings.json");

forbidDependency("apps/agent-cli/package.json", "@lxe/gateway", "Agent host must not depend on Gateway");
forbidDependency("apps/gateway/package.json", "@lxe/runtime", "Gateway must depend on runtime ports, not the concrete Runtime");
forbidDependency("apps/desktop/package.json", "@lxe/runtime", "Desktop must use Core for shared machine concerns");
if (Object.keys(manifestDependencies("packages/foundation/core/package.json")).length > 0) {
  failures.push("packages/foundation/core/package.json: Core must have no production dependencies");
}

const packageImportBoundaries = [
  {
    patterns: ["apps/agent-cli/src/**/*.ts", "apps/agent-cli/test/**/*.ts"],
    importPattern: /["']@lxe\/gateway(?:\/[^"']*)?["']/,
    message: "Agent host source must not import Gateway",
  },
  {
    patterns: ["apps/gateway/src/**/*.ts", "apps/gateway/test/**/*.ts"],
    importPattern: /["']@lxe\/runtime(?:\/[^"']*)?["']/,
    message: "Gateway source and tests must not import the concrete Runtime",
  },
  {
    patterns: ["apps/desktop/src/**/*.ts", "apps/desktop/test/**/*.ts"],
    importPattern: /["']@lxe\/runtime(?:\/[^"']*)?["']/,
    message: "Desktop source and tests must not import the concrete Runtime",
  },
] as const;
for (const boundary of packageImportBoundaries) {
  for (const pattern of boundary.patterns) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
      if (boundary.importPattern.test(read(path))) failures.push(`${path}: ${boundary.message}`);
    }
  }
}

const forbiddenErrorSurrogates = [
  /Feishu system diagnostic: quoted message could not be retrieved/,
  /Feishu [^\n]+ download failed; cause_known=false/,
  /Interactive card content unavailable/,
  /Unable to process Feishu image/,
] as const;
for (const pattern of ["apps/**/src/**/*.ts", "packages/**/src/**/*.ts"]) {
  for await (const path of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
    for (const forbidden of forbiddenErrorSurrogates) {
      if (forbidden.test(read(path))) failures.push(`${path}: production code must preserve actual operation errors instead of injecting a fixed surrogate`);
    }
  }
}

forbidPath("main.py", "the legacy Python production entrypoint must be deleted");
for (const path of [
  "agent_runtime",
  "browser_auth_service",
  "clients",
  "gateway",
  "lxeskill",
  "platforms",
  "services",
  "shared",
  "tests",
]) {
  forbidPath(path, "legacy top-level Python directory must be deleted");
}
forbidPath("apps/gateway/src/orchestration/gateway-composition.ts", "the worker Gateway composition must be deleted");
forbidPath("apps/gateway/src/orchestration/worker-client.ts", "the worker client must be deleted");
forbidPath("apps/gateway/src/orchestration/worker-process.ts", "the worker process launcher must be deleted");
forbidPath("apps/gateway/src/orchestration/worker-supervisor.ts", "the worker supervisor must be deleted");
forbidPath("apps/gateway/src/main.ts", "the standalone Gateway CLI must be deleted");
forbidPath("apps/gateway/src/bootstrap/cli.ts", "the standalone Gateway bootstrap must be deleted");
forbidPath("apps/gateway/src/orchestration/production.ts", "the standalone Gateway production assembly must be deleted");
forbidPath("apps/gateway/src/dashboard/server.ts", "the browser Dashboard HTTP server must be deleted");
forbidPath("apps/gateway/src/dashboard/browser.ts", "the browser Dashboard opener must be deleted");
forbidPath("apps/gateway/src/dashboard/api.ts", "the pseudo-REST Dashboard API must be replaced by a typed service");
forbidPath("apps/gateway/src/dashboard/service.ts", "Agent Dashboard service belongs to the agent-cli host");
forbidPath("apps/gateway/src/orchestration/agent-service.ts", "Agent composition root belongs to the agent-cli host");
forbidPath("apps/gateway/src/channels/feishu/tools.ts", "Agent-native Feishu tools belong to the agent-cli host");
forbidPath("apps/gateway/src/channels/feishu/image.ts", "Gateway must receive an inbound image processor port implementation");
forbidPath("packages/agent/runtime/src/operations/machine-identity.ts", "machine identity belongs to Core");
requirePath("apps/agent-cli/src/runtime-host.ts", "agent-cli must own its Runtime composition root");
requirePath("apps/agent-cli/src/dashboard-service.ts", "agent-cli must own Agent Dashboard queries");
forbidPath("apps/agent-cli/src/feishu-tools.ts", "built-in Feishu message tools must remain retired in favor of lark-cli");
forbidPath("skills/feishu-im-read/SKILL.md", "the retired feishu-im-read Skill must not re-enter the build");
requirePath("skills/larksuite-cli/lark-im/SKILL.md", "lark-cli IM operations must remain available");
requirePath("packages/foundation/core/src/machine-identity.ts", "Core must own the shared machine identity implementation");
forbidPath("packages/foundation/protocol/schemas/worker-envelope.schema.json", "the worker envelope contract must be deleted");
forbidPath("packages/agent/runtime/src/tooling/script-tools.ts", "the retired script-tool runner must be deleted");
forbidPath("python/lxeskill_cli/lxeskill/bridge.py", "the retired Python bridge entrypoint must be deleted");
forbidText("packages/foundation/protocol/src/types.ts", /WorkerEnvelope/, "protocol types must not expose a worker envelope");

const pythonImports = /(?:^|\n)\s*(?:from|import)\s+(?:gateway|agent_runtime)(?:\.|\s|$)/m;
for (const path of repositoryFiles("*.py")) {
  if (pythonImports.test(read(path))) failures.push(`${path}: retained Python must not import gateway or agent_runtime`);
}

const scriptCatalogPath = "python/lxeskill_cli/lxeskill/catalog.json";
const scriptCatalog = JSON.parse(read(scriptCatalogPath)) as {
  protocol_version?: string;
  entries?: Array<{
    name?: string;
    exposed?: boolean;
    owner_skills?: string[];
    attribution_skill?: string;
    command_path?: string[];
    visibility?: string;
  }>;
};
if (scriptCatalog.protocol_version !== "1") failures.push(`${scriptCatalogPath}: protocol_version must be 1`);
const commandEntries = new Map((scriptCatalog.entries ?? []).map((entry) => [
  `lxeskill ${(entry.command_path ?? []).map(String).join(" ")}`.trim(),
  entry,
]));
for (const [command, entry] of commandEntries) {
  const owners = entry.owner_skills ?? [];
  const attribution = String(entry.attribution_skill ?? "").trim();
  if (owners.length > 1 && !attribution) {
    failures.push(`${scriptCatalogPath}: ${command} has multiple owner_skills but no attribution_skill`);
  }
  if (attribution && !owners.includes(attribution)) {
    failures.push(`${scriptCatalogPath}: ${command} attribution_skill is not an owner_skill`);
  }
}
const declaredCommands = new Map<string, string>();
for await (const path of new Bun.Glob("skills/**/SKILL.md").scan({ cwd: root, onlyFiles: true })) {
  const source = read(path);
  const frontmatter = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  const skillName = frontmatter.match(/^name:\s*([^\r\n#]+)/m)?.[1]?.trim() ?? "";
  if (/^script_tools:/m.test(frontmatter)) failures.push(`${path}: script_tools metadata is retired; use commands`);
  const commandBlock = frontmatter.match(/^commands:\s*\r?\n((?:\s+-[^\r\n]+\r?\n?)*)/m)?.[1] ?? "";
  const commands = [...commandBlock.matchAll(/^\s+-\s*([^#\r\n]+?)\s*$/gm)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
  if (/\b(?:uv\s+run[^\r\n]*python|python(?:3)?\s+-m)\s+services\.agent_cli\b/i.test(source)) {
    failures.push(`${path}: active skill must use lxeskill instead of shelling out to a business Python module`);
  }
  if (/services\.agent_cli\./.test(source)) failures.push(`${path}: active skill must not reference business module paths`);
  for (const command of commands.filter((value) => value.startsWith("lxeskill "))) {
    const entry = commandEntries.get(command);
    if (!entry || !["business", "browser"].includes(String(entry.visibility ?? ""))) {
      failures.push(`${path}: unknown or non-business lxeskill command ${command}`);
      continue;
    }
    const owners = entry.owner_skills ?? [];
    const canonicalOwner = entry.attribution_skill ?? (owners.length === 1 ? owners[0] : "");
    if (canonicalOwner !== skillName) {
      failures.push(`${path}: lxeskill command ${command} is canonically owned by ${canonicalOwner || "nobody"}`);
    }
    const existingOwner = declaredCommands.get(command);
    if (existingOwner && existingOwner !== skillName) {
      failures.push(`${path}: duplicate lxeskill command ownership ${command}: ${existingOwner}, ${skillName}`);
    }
    declaredCommands.set(command, skillName);
  }
}
for (const [command, entry] of commandEntries) {
  if (!["business", "browser"].includes(String(entry.visibility ?? ""))) continue;
  const owners = entry.owner_skills ?? [];
  const canonicalOwner = entry.attribution_skill ?? (owners.length === 1 ? owners[0] : "");
  if (!canonicalOwner) failures.push(`${scriptCatalogPath}: ${command} has no canonical owner skill`);
  else if (declaredCommands.get(command) !== canonicalOwner) {
    failures.push(`${scriptCatalogPath}: ${command} is missing from canonical owner skill ${canonicalOwner}`);
  }
}

const bundleRoot = mkdtempSync(join(tmpdir(), "lxe-agent-cli-boundary-"));
try {
  const metafile = join(bundleRoot, "metafile.json");
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "build",
      "apps/agent-cli/src/main.ts",
      "--target=bun",
      `--outdir=${join(bundleRoot, "dist")}`,
      `--metafile=${metafile}`,
    ],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    failures.push(`agent-cli bundle check failed: ${result.stderr.toString().trim()}`);
  } else {
    const metadata = JSON.parse(readFileSync(metafile, "utf8")) as { inputs?: Record<string, unknown> };
    const gatewayInputs = Object.keys(metadata.inputs ?? {}).filter((path) =>
      path.replaceAll("\\", "/").includes("apps/gateway/src/"));
    if (gatewayInputs.length > 0) {
      failures.push(`agent-cli bundle contains Gateway modules: ${gatewayInputs.join(", ")}`);
    }
  }
} finally {
  rmSync(bundleRoot, { recursive: true, force: true });
}

const staleArchitectureDocs = /main\.py|agent_runtime|gateway\/[A-Za-z0-9_/-]+\.py|Python\s+(?:Gateway|Runtime|Dashboard|backend)/i;
for (const pattern of ["README.md", "apps/dashboard/**/*.md", "docs/harness/**/*.md", "docs/database/**/*.md"]) {
  for await (const path of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
    if (staleArchitectureDocs.test(read(path))) {
      failures.push(`${path}: documentation must describe the Bun-only production architecture`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log("TypeScript production boundary OK");

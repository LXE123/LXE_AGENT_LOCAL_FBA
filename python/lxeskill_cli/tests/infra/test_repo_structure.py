"""Repository structure contracts.

The top-level layout answers one question per directory: which runtime world
does this belong to (TypeScript apps/packages / Python lxeskill closure /
assets / state)? These tests freeze that layout and the env naming rule so
drift shows up in review instead of months later.

Changing the frozen sets is allowed — do it together with a dated entry in
docs/record explaining the structure decision.
"""
from __future__ import annotations

import re
import subprocess
import tomllib
from pathlib import Path

from shared.repository import repository_root

REPO_ROOT = repository_root()

ALLOWED_TOP_LEVEL_DIRECTORIES = {
    # TS world
    "apps",
    "packages",
    # Python world
    "python",
    # Assets and supporting material
    "skills",
    "config",
    "docs",
    "scripts",
}

ALLOWED_APP_DIRECTORIES = {"agent-cli", "dashboard", "desktop", "gateway"}
ALLOWED_PACKAGE_DIRECTORIES = {"agent", "foundation"}
ALLOWED_FOUNDATION_PACKAGE_DIRECTORIES = {"core", "desktop-protocol", "protocol"}
ALLOWED_AGENT_PACKAGE_DIRECTORIES = {"runtime"}
ALLOWED_GATEWAY_SOURCE_DIRECTORIES = {
    "bootstrap",
    "channels",
    "orchestration",
    "state",
}
ALLOWED_GATEWAY_TEST_DIRECTORIES = {
    "bootstrap",
    "channels",
    "orchestration",
    "state",
}
ALLOWED_RUNTIME_SOURCE_DIRECTORIES = {
    "engine",
    "messages",
    "operations",
    "providers",
    "state",
    "tooling",
    "workspace",
}
ALLOWED_RUNTIME_TEST_DIRECTORIES = ALLOWED_RUNTIME_SOURCE_DIRECTORIES
ALLOWED_DASHBOARD_SOURCE_DIRECTORIES = {"api", "assets", "desktop", "features", "shared"}
ALLOWED_DASHBOARD_TEST_DIRECTORIES = {"architecture", "desktop", "features", "shared"}

ALLOWED_PYTHON_DIRECTORIES = {"lxeskill_cli"}
ALLOWED_LXESKILL_CLI_DIRECTORIES = {
    "browser_auth_service",
    "lxeskill",
    "services",
    "shared",
    "tests",
}

# Frozen on 2026-07-14. New runtime configuration must use the LXE_ prefix
# (domain-scoped keys use a second segment, e.g. LXE_MABANG_*). Removing a
# legacy key is always allowed; never add to this list.
LEGACY_RUNTIME_ENV_KEYS = {
    "AGENT_LLM_MODEL",
    "AGENT_LLM_PROVIDER",
    "AGENT_LLM_THINKING_EFFORT",
    "AGENT_LLM_THINKING_ENABLED",
    "AGENT_SSE_WIRE_TRACE_ENABLED",
    "BROWSER_AUTH_HEADLESS",
    "FBA_DELIVERY_CSV_DIR",
    "FEISHU_RAW_EVENT_DUMP_ENABLED",
    "LOCAL_LOGS_ENABLED",
    "LOCAL_LOG_RETENTION_DAYS",
    "LOG_LEVEL",
    "LOG_LEVELS",
    "MABANG_FBA_STORE_RESOLVER_OUTPUT_DIR",
    "MABANG_FBA_UNLINKED_SHIPMENTS_OUTPUT_DIR",
    "MABANG_MSKU_DETAIL_OUTPUT_DIR",
    "MABANG_STOCK_SKU_EXPORT_DIR",
    "MABANG_STORE_MSKU_ANALYSIS_OUTPUT_DIR",
    "MABANG_STORE_MSKU_INVENTORY_OUTPUT_DIR",
    "MABANG_STORE_MSKU_OUTPUT_DIR",
    "MABANG_STORE_MSKU_REPLENISHMENT_OUTPUT_DIR",
    "RUNTIME_LOG_LEVEL",
    "ZINIAO_BROWSER_VERSION",
    "ZINIAO_CLIENT_PATH",
    "ZINIAO_DIAGNOSTIC_TRACE_ENABLED",
    "ZINIAO_REGISTER_PLANNER_TOOLS",
    "ZINIAO_WEBDRIVER_PATH",
}


def _repository_paths() -> list[str]:
    output = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
    ).stdout.decode("utf-8")
    return [
        path
        for path in output.split("\0")
        if path and (REPO_ROOT / path).exists()
    ]


def _is_git_ignored(path: Path) -> bool:
    result = subprocess.run(
        ["git", "check-ignore", "-q", "--", path.name],
        cwd=REPO_ROOT,
        check=False,
    )
    if result.returncode not in {0, 1}:
        result.check_returncode()
    return result.returncode == 0


def _repository_top_level_directories() -> set[str]:
    return {
        path.name
        for path in REPO_ROOT.iterdir()
        if path.is_dir() and path.name != ".git" and not _is_git_ignored(path)
    }


def _repository_directories_below(prefix: str) -> set[str]:
    normalized_prefix = prefix.rstrip("/") + "/"
    directories: set[str] = set()
    for path in _repository_paths():
        if not path.startswith(normalized_prefix):
            continue
        relative_path = path[len(normalized_prefix) :]
        if "/" in relative_path:
            directories.add(relative_path.split("/", 1)[0])
    return directories


def _production_dependency_names() -> set[str]:
    configuration = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text("utf-8"))
    dependencies = configuration.get("project", {}).get("dependencies", [])
    return {
        match.group(0).lower().replace("_", "-")
        for dependency in dependencies
        if (match := re.match(r"[A-Za-z0-9_.-]+", str(dependency)))
    }


def test_top_level_directories_stay_in_the_frozen_set() -> None:
    unexpected = _repository_top_level_directories() - ALLOWED_TOP_LEVEL_DIRECTORIES
    assert unexpected == set(), (
        "new top-level directories need a structure decision in docs/record "
        f"before extending the frozen set: {sorted(unexpected)}"
    )


def test_python_world_contains_only_the_lxeskill_cli_closure() -> None:
    assert _repository_directories_below("python") == ALLOWED_PYTHON_DIRECTORIES


def test_desktop_image_runtime_keeps_pillow_in_production_dependencies() -> None:
    assert "pillow" in _production_dependency_names()


def test_lxeskill_cli_closure_contains_only_frozen_domains() -> None:
    assert (
        _repository_directories_below("python/lxeskill_cli")
        == ALLOWED_LXESKILL_CLI_DIRECTORIES
    )


def test_typescript_workspaces_follow_domain_layout() -> None:
    assert _repository_directories_below("apps") == ALLOWED_APP_DIRECTORIES
    assert _repository_directories_below("packages") == ALLOWED_PACKAGE_DIRECTORIES
    assert (
        _repository_directories_below("packages/foundation")
        == ALLOWED_FOUNDATION_PACKAGE_DIRECTORIES
    )
    assert (
        _repository_directories_below("packages/agent")
        == ALLOWED_AGENT_PACKAGE_DIRECTORIES
    )


def test_large_typescript_workspaces_use_frozen_source_domains() -> None:
    assert (
        _repository_directories_below("apps/gateway/src")
        == ALLOWED_GATEWAY_SOURCE_DIRECTORIES
    )
    assert (
        _repository_directories_below("packages/agent/runtime/src")
        == ALLOWED_RUNTIME_SOURCE_DIRECTORIES
    )
    assert (
        _repository_directories_below("apps/dashboard/src")
        == ALLOWED_DASHBOARD_SOURCE_DIRECTORIES
    )


def test_typescript_tests_mirror_source_domains() -> None:
    assert (
        _repository_directories_below("apps/gateway/test")
        == ALLOWED_GATEWAY_TEST_DIRECTORIES
    )
    assert (
        _repository_directories_below("packages/agent/runtime/test")
        == ALLOWED_RUNTIME_TEST_DIRECTORIES
    )
    assert (
        _repository_directories_below("apps/dashboard/test")
        == ALLOWED_DASHBOARD_TEST_DIRECTORIES
    )


def test_lxeskill_cli_container_is_not_a_python_package() -> None:
    container_init = REPO_ROOT / "python" / "lxeskill_cli" / "__init__.py"
    assert not container_init.exists(), (
        "python/lxeskill_cli is a source-closure container, not a public package"
    )


def test_runtime_docs_do_not_reference_legacy_root_log_paths() -> None:
    legacy_path = re.compile(
        r"(?<!var/)logs/(?:runtime|feishu_raw_events|agent_traces|sse_wire_traces)"
    )
    offenders: list[str] = []
    for relative_path in ("README.md", "docs/harness/logger.md"):
        text = (REPO_ROOT / relative_path).read_text("utf-8")
        if legacy_path.search(text):
            offenders.append(relative_path)
    assert offenders == [], (
        "runtime documentation must keep logs under var/logs: "
        f"{offenders}"
    )


def test_retired_workspace_scope_is_absent() -> None:
    needles = (
        "server_" + "scope",
        "server" + "Scope",
        "Server " + "scope",
    )
    text_suffixes = {".json", ".md", ".py", ".ts", ".tsx"}
    offenders: list[str] = []
    for relative_path in _repository_paths():
        path = REPO_ROOT / relative_path
        if path.suffix not in text_suffixes:
            continue
        text = path.read_text("utf-8")
        if any(needle in text for needle in needles):
            offenders.append(relative_path)
    assert offenders == [], (
        "the retired workspace scope must not remain in source, schemas, fixtures, or docs: "
        f"{offenders}"
    )

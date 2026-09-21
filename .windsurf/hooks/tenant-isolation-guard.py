#!/usr/bin/env python3
"""
Harness v3 Hook: Tenant Isolation Guard  (Parent Line specific)
Enforces AGENTS.md rules 7 and 11:
  - no raw pool.query outside src/repositories/
  - no tenant_id accepted as a tool/handler argument
Exit 2 = BLOCK.
"""
import os, re, sys
sys.path.insert(0, os.path.dirname(__file__))
from _common import read_input, file_path

CODE_EXT = (".ts", ".tsx", ".js", ".mjs")
REPO_LAYER = ("src/repositories/", "src/db/")
AUTH_LAYER = ("src/auth/", "src/tenancy/")

def main():
    data = read_input()
    fp = file_path(data).replace("\\", "/")
    if not fp.endswith(CODE_EXT):
        sys.exit(0)

    ti = data.get("tool_info", {})
    content = ""
    for key in ("content", "new_str", "new_content", "text"):
        if isinstance(ti.get(key), str):
            content += ti[key]
    if not content:
        sys.exit(0)

    if not any(seg in fp for seg in REPO_LAYER):
        if re.search(r"\b(pool|client|db)\.query\s*\(", content):
            print("TENANT ISOLATION GUARD: raw query outside the repository layer.", file=sys.stderr)
            print(f"  File: {fp}", file=sys.stderr)
            print("  All data access goes through src/repositories/ under withTenant().", file=sys.stderr)
            print("  A query written without a tenant filter is a cross-tenant leak (test T-01).", file=sys.stderr)
            sys.exit(2)

    if not any(seg in fp for seg in AUTH_LAYER):
        if re.search(r"(tenantId|tenant_id)\s*[?]?\s*:\s*string", content):
            print("TENANT ISOLATION GUARD: tenant_id appears as a parameter.", file=sys.stderr)
            print(f"  File: {fp}", file=sys.stderr)
            print("  tenant_id is derived server-side from the session, never passed in.", file=sys.stderr)
            print("  An external model fills tool arguments (AGENTS.md rule 7).", file=sys.stderr)
            sys.exit(2)

    sys.exit(0)

if __name__ == "__main__":
    main()

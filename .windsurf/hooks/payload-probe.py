#!/usr/bin/env python3
"""
Harness Step-0 probe — capture, never enforce.

Wired to every pre- event by hooks.step0.json. Dumps each raw payload to
.windsurf/state/payloads/<event>-<epoch>.json so the key lists in
_common.py, phase-writer.py, and mcp-phase-router.py are verified against
what Windsurf actually sends — not what the docs were assumed to say.

Not part of hooks.json. Kept unwired for future schema checks.
"""
import json
import os
import sys
import time

PAYLOADS_DIR = os.path.join(".windsurf", "state", "payloads")


def main():
    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        data = {"_unparsed": raw}
    event = data.get("agent_action_name", "unknown") if isinstance(data, dict) else "unknown"

    try:
        os.makedirs(PAYLOADS_DIR, exist_ok=True)
        name = f"{event}-{int(time.time() * 1000)}.json"
        with open(os.path.join(PAYLOADS_DIR, name), "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, sort_keys=True)
        print(f"payload-probe: captured {event} -> {name}")
    except OSError as e:
        print(f"payload-probe: could not write payload ({e})")

    sys.exit(0)


if __name__ == "__main__":
    main()

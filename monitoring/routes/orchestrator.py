#!/usr/bin/env python3
"""Read-only plan for the R5S-push route collection architecture.

Execution deliberately lives in ``r5s/run_and_push.sh`` and the forced-command
receiver ``routes/ingest_and_return.py``.  The Feiniu host never initiates SSH
to R5S.
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from routes.core import RouteConfigError, load_config, outbound_tasks, return_tasks  # type: ignore
    from routes.ingest_and_return import ingest_execution_blockers  # type: ignore
else:
    from .core import RouteConfigError, load_config, outbound_tasks, return_tasks
    from .ingest_and_return import ingest_execution_blockers


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "config" / "routes.json"


def execution_blockers(config: dict) -> list[str]:
    """Compatibility alias used by the offline tests and plan output."""
    return ingest_execution_blockers(config)


def plan(config: dict) -> dict:
    outbound = outbound_tasks(config)
    returns = return_tasks(config, {})
    push = config["r5s_push"]
    public_ip_worst = 3 * int(config["public_ip"]["process_timeout_seconds"])
    outbound_worst = len(outbound) * int(config["nexttrace"]["process_timeout_seconds"])
    return_worst = len(returns) * (int(config["nexttrace"]["process_timeout_seconds"]) + 15)
    return {
        "architecture": push["architecture"],
        "deployment_enabled": bool(config.get("deployment_enabled")),
        "trigger_host": "R5S",
        "receiver_host": push["ssh_host"],
        "forced_command": push["forced_command"],
        "blackout": f"{config['schedule']['blackout_start']}-{config['schedule']['blackout_end']}",
        "r5s_public_ip_count": 3,
        "outbound_count": len(outbound),
        "outbound": [asdict(task) for task in outbound],
        "return_count": len(returns),
        "return": [asdict(task) for task in returns],
        "bundle_record_count": 3 + len(outbound),
        "max_bundle_bytes": int(push["max_bundle_bytes"]),
        "max_concurrent_nexttrace": 1,
        "worst_case_r5s_seconds": public_ip_worst + outbound_worst,
        "worst_case_receiver_seconds": return_worst,
        "worst_case_end_to_end_seconds": public_ip_worst + outbound_worst + return_worst,
        "automatic_retries": 0,
        "blockers": execution_blockers(config),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="R5S-push daily NextTrace route plan")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument(
        "--execute", action="store_true",
        help="always rejected; execution must be triggered locally on R5S",
    )
    args = parser.parse_args()
    try:
        config = load_config(args.config)
        if args.execute:
            print(json.dumps({
                "status": "blocked",
                "reason": "reverse_trigger_required",
                "entrypoint": "/root/network-monitor/run_and_push.sh",
            }, ensure_ascii=False))
            return 78
        print(json.dumps(plan(config), ensure_ascii=False, indent=2))
        return 0
    except (OSError, RouteConfigError, ValueError) as exc:
        print(json.dumps({
            "status": "error",
            "error": type(exc).__name__,
            "detail": str(exc),
        }, ensure_ascii=False))
        return 64


if __name__ == "__main__":
    raise SystemExit(main())

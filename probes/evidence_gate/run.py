#!/usr/bin/env python3
"""CLI runner for the offline evidence-gate decision probe.

Usage:
    python3 probes/evidence_gate/run.py --output <directory>

Writes ``receipt.json`` (internal synthetic diagnostic) and ``report.md``
(human-readable decision receipt) into the caller-supplied output directory.
Temporary SQLite databases live under a TemporaryDirectory and are auto-cleaned.
Exits nonzero if any declared check or fatal gate fails. Zero network/model/
provider calls. If the artifact private-material scan matches, free-text
diagnostic content is replaced by marker names before anything is written.
"""

from __future__ import annotations

import argparse
import datetime as _datetime
import json
import os
import sys
import tempfile

import cases
import core
import fixtures

OFFICIAL_REFERENCES = {
    "sqlite3": "https://docs.python.org/3.12/library/sqlite3.html",
    "unittest": "https://docs.python.org/3.12/library/unittest.html",
}


def _observed_facts(results):
    """Build observed facts from actual case outcomes, never from a hardcoded
    success list."""

    facts = []
    for result in results:
        failed = [check["name"] for check in result["checks"] if not check["passed"]]
        if failed:
            facts.append(f"case {result['case_id']} failed checks: " + ", ".join(failed))
        else:
            facts.extend(result["observed_facts"])
    return facts


def _summary(results, fatal_gates):
    case_checks = [check for case in results for check in case["checks"]]
    total_checks = len(case_checks) + len(fatal_gates)
    passed_checks = sum(1 for check in case_checks if check["passed"]) + sum(
        1 for gate in fatal_gates if gate["passed"]
    )
    failed_cases = [case["case_id"] for case in results if not all(c["passed"] for c in case["checks"])]
    failed_cases += [gate["name"] for gate in fatal_gates if not gate["passed"]]
    return {
        "total_cases": len(results),
        "passed_cases": len(results) - len([c for c in results if not all(x["passed"] for x in c["checks"])]),
        "failed_cases": failed_cases,
        "total_checks": total_checks,
        "passed_checks": passed_checks,
        "all_checks_passed": not failed_cases and passed_checks == total_checks,
    }


def _renderer_parity_sample():
    snapshot = fixtures.base_snapshot()
    view = core.build_public_view(snapshot)
    view_json = core.render_json(view)
    view_md = core.render_markdown(view)
    parsed = json.loads(view_json)
    return {
        "revision": parsed["revision"],
        "as_of": parsed["as_of"],
        "claim_ids": [c["claim_id"] for c in parsed["claims"]],
        "evidence_ids": [e["evidence_id"] for e in parsed["evidence"]],
        "person_anchors": [p["report_anchor"] for p in parsed["people_index"]],
        "json": view_json,
        "markdown": view_md,
    }


def _write_decision_markdown(receipt):
    lines = []
    lines.append("# 证据门禁探针 · 决定回执")
    lines.append("")
    lines.append("> 类型：synthetic / discovery / unreviewed。输入是作者编写的显式标注，不是抽取器。")
    lines.append("> 不访问网络、模型或 provider；未运行仓库原有 12 个 discovery case。")
    lines.append("")
    lines.append("## 问题")
    lines.append("")
    lines.append(
        "在显式标注的合成身份/证据图上，共享 canonical report 加修订/导出门禁"
        "能否在身份撤销、来源不可读或导出权限收紧后阻止 JSON 与 Markdown 输出失效结论，"
        "并保留不受影响的结论？"
    )
    lines.append("")
    summary = receipt["summary"]
    lines.append("## 自动判定")
    lines.append("")
    lines.append(f"- automated_verdict: **{receipt['automated_verdict']}**")
    lines.append("- human_choice: **unreviewed**（自动通过不升级为人工 gold）")
    lines.append(
        f"- 合成检查：{summary['passed_checks']}/{summary['total_checks']} 通过，"
        f"{summary['passed_cases']}/{summary['total_cases']} 案例通过"
    )
    lines.append(
        f"- forbidden-call 观察：进程内守卫记录到 {receipt['network']['requests_attempted']} 次尝试"
    )
    lines.append(f"- artifact scan passed: {receipt['artifact_scan']['passed']}")
    if receipt.get("redacted"):
        lines.append(f"- redacted: {receipt.get('redaction_reason')}")
    lines.append("")
    lines.append("## 案例结果")
    lines.append("")
    lines.append("| case | 结果 | 检查 |")
    lines.append("|---|---|---|")
    for case in receipt["cases"]:
        checks = case.get("checks")
        if checks is None:
            passed = case.get("passed")
            lines.append(
                f"| `{case['case_id']}` | {'pass' if passed else 'FAIL'} | "
                f"{', '.join(case.get('check_names', []))} |"
            )
        else:
            ok = all(c["passed"] for c in checks)
            passed = sum(1 for c in checks if c["passed"])
            lines.append(f"| `{case['case_id']}` | {'pass' if ok else 'FAIL'} | {passed}/{len(checks)} |")
    lines.append("")
    if receipt.get("redacted"):
        lines.append("## 已脱敏")
        lines.append("")
        lines.append(
            "artifact 私密材料扫描命中，自由文本诊断内容已省略，仅保留标记名与检查名。"
        )
        lines.append("")
    lines.append("## 观察事实")
    lines.append("")
    for fact in receipt["distinctions"]["observed_facts"]:
        lines.append(f"- {fact}")
    lines.append("")
    lines.append("## AI 假设")
    lines.append("")
    lines.append(f"- {receipt['distinctions']['ai_hypothesis']}")
    lines.append("")
    lines.append("## 未验证 / 剩余不确定性")
    lines.append("")
    for item in receipt["distinctions"]["remaining_uncertainty"]:
        lines.append(f"- {item}")
    lines.append("")
    if receipt.get("renderer_parity_sample"):
        lines.append("## 公共导出样例（同一过滤快照）")
        lines.append("")
        lines.append(receipt["renderer_parity_sample"]["markdown"])
        lines.append("")
    lines.append("## 运行方式")
    lines.append("")
    lines.append("```")
    lines.append("python3 -m unittest discover -s probes/evidence_gate -p 'test_*.py' -v")
    lines.append("python3 probes/evidence_gate/run.py --output <directory>")
    lines.append("```")
    lines.append("")
    lines.append("## 官方参考")
    lines.append("")
    for name, url in OFFICIAL_REFERENCES.items():
        lines.append(f"- {name}: {url}")
    lines.append("")
    return "\n".join(lines)


def build_receipt(results, guard, fatal_gates):
    summary = _summary(results, fatal_gates)
    return {
        "probe": "evidence_gate",
        "schema_version": core.SCHEMA_VERSION,
        "synthetic": True,
        "provenance": {
            "source": "synthetic",
            "split": "discovery",
            "review_status": "unreviewed",
        },
        "generated_by": "authored_probe_runner_not_agent_run",
        "automated_verdict": "supported" if summary["all_checks_passed"] else "rejected",
        "human_choice": "unreviewed",
        "network": {
            "guard": "in-process Python monkeypatch (stdlib socket/urllib)",
            "honest_limit": (
                "只在当前解释器内拦截到达 stdlib socket 属性的调用；不是 OS 沙箱，"
                "不阻止子进程、C 扩展或守卫前缓存的引用。"
            ),
            "requests_attempted": len(guard.attempts),
            "attempts": guard.attempts,
        },
        "official_references": OFFICIAL_REFERENCES,
        "cases": results,
        "summary": summary,
        "distinctions": {
            "observed_facts": _observed_facts(results),
            "automated_verdict": "全部门禁与声明检查通过时为 supported，否则 rejected。",
            "human_choice": "unreviewed",
            "ai_hypothesis": (
                "门禁设计可能迁移到真实采集管线；本探针只研究合成标注上的依赖失效行为，"
                "不测抽取、语义蕴含、检索质量、真实精度或用户收益。"
            ),
            "remaining_uncertainty": [
                "文本字段的来源是作者声明的标注，不是语义真值；探针只检查被引用节点的可达权限。",
                "只覆盖作者构造的合成依赖形状，不代表真实报告的依赖图分布。",
                "进程内网络守卫不是沙箱，无法证明子进程或非 Python 工具未联网。",
                "自动判定未经过人工评审，结论保持 unreviewed。",
            ],
        },
        "renderer_parity_sample": _renderer_parity_sample(),
    }


def _redacted_receipt(receipt, leaked, fatal_gates):
    """Marker names only: drop all free-text diagnostic content."""

    summary = _summary([], fatal_gates)
    summary["total_cases"] = receipt["summary"]["total_cases"]
    summary["passed_cases"] = receipt["summary"]["passed_cases"]
    summary["total_checks"] = receipt["summary"]["total_checks"]
    summary["passed_checks"] = receipt["summary"]["passed_checks"]
    summary["all_checks_passed"] = False
    return {
        "probe": receipt["probe"],
        "schema_version": receipt["schema_version"],
        "synthetic": True,
        "provenance": receipt["provenance"],
        "generated_by": receipt["generated_by"],
        "automated_verdict": "rejected",
        "human_choice": "unreviewed",
        "redacted": True,
        "redaction_reason": "artifact scan matched restricted markers; free-text content omitted",
        "artifact_scan": {"passed": False, "matches": leaked},
        "network": receipt["network"],
        "official_references": receipt["official_references"],
        "cases": [
            {
                "case_id": case["case_id"],
                "passed": all(check["passed"] for check in case["checks"]),
                "check_names": [check["name"] for check in case["checks"]],
            }
            for case in receipt["cases"]
        ],
        "summary": summary,
        "distinctions": {
            "observed_facts": ["artifact redacted; see case check names"],
            "automated_verdict": "rejected",
            "human_choice": "unreviewed",
            "ai_hypothesis": "not evaluated in redacted artifacts",
            "remaining_uncertainty": ["redacted artifacts omit free-text diagnostic content"],
        },
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run the offline evidence-gate decision probe.")
    parser.add_argument("--output", required=True, help="directory for receipt.json and report.md")
    args = parser.parse_args(argv)

    output_dir = os.path.abspath(args.output)
    os.makedirs(output_dir, exist_ok=True)

    with core.NetworkGuard() as guard, tempfile.TemporaryDirectory(prefix="evidence-gate-") as workspace:
        results = cases.run_all(workspace)

    fatal_gates = [
        {
            "name": "network-forbidden-call-observation",
            "passed": not guard.attempts,
            "detail": f"attempts={len(guard.attempts)}",
        }
    ]
    receipt = build_receipt(results, guard, fatal_gates)
    receipt["artifact_scan"] = {"passed": True, "matches": []}

    receipt_text = json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True)
    report_text = _write_decision_markdown(receipt)
    leaked = sorted(
        set(core.scan_for_private_material(receipt_text) + core.scan_for_private_material(report_text))
    )
    if leaked:
        fatal_gates.append(
            {
                "name": "artifact-private-material-scan",
                "passed": False,
                "detail": f"matches={leaked}",
            }
        )
        receipt = _redacted_receipt(receipt, leaked, fatal_gates)
        receipt["summary"] = _summary(results, fatal_gates)
        receipt["automated_verdict"] = (
            "supported" if receipt["summary"]["all_checks_passed"] else "rejected"
        )
        receipt_text = json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True)
        report_text = _write_decision_markdown(receipt)
        again = sorted(
            set(core.scan_for_private_material(receipt_text) + core.scan_for_private_material(report_text))
        )
        if again:
            # Even the redacted artifact matched the (simulated) scanner; write
            # marker names and check names only, never the matched content.
            receipt["artifact_scan"]["matches"] = sorted(set(leaked) | set(again))
            receipt_text = json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True)

    with open(os.path.join(output_dir, "receipt.json"), "w", encoding="utf-8") as handle:
        handle.write(receipt_text + "\n")
    with open(os.path.join(output_dir, "report.md"), "w", encoding="utf-8") as handle:
        handle.write(report_text)

    summary = receipt["summary"]
    print(
        f"{receipt['automated_verdict'].upper()}: "
        f"{summary['passed_checks']}/{summary['total_checks']} checks, "
        f"{summary['passed_cases']}/{summary['total_cases']} cases; "
        f"human_choice=unreviewed; forbidden_calls={receipt['network']['requests_attempted']}; "
        f"artifact_scan={receipt['artifact_scan']['passed']}"
    )
    if summary["failed_cases"]:
        print("failed: " + ", ".join(summary["failed_cases"]), file=sys.stderr)
    print(
        "note: synthetic probe; no network/model/provider calls; "
        "run at " + _datetime.datetime.now().isoformat(timespec="seconds"),
        file=sys.stderr,
    )
    return 0 if summary["all_checks_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

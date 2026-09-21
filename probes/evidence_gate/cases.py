"""Deterministic cases for the evidence-gate decision probe.

Each case builds an explicitly authored synthetic snapshot, applies one gate or
revision/export operation, and asserts observed behavior. Failing inputs are
expected rejections, not case-execution failures. No case replays hardcoded
PASS output; every check inspects the core's behavior.
"""

from __future__ import annotations

import copy
import json
import os
import sqlite3

import core
import fixtures


def _check(name, passed, detail=""):
    return {"name": name, "passed": bool(passed), "detail": detail}


def _expect_gate_error(name, snapshot, code):
    try:
        core.validate_snapshot(snapshot)
    except core.GateError as exc:
        return _check(name, exc.code == code, f"observed {exc.code}")
    return _check(name, False, f"expected {code}, gate accepted")


def _new_store(workspace, name):
    return core.SnapshotStore(os.path.join(workspace, name))


# ---------------------------------------------------------------------------
# Case 1: positive coverage on a valid, unaffected branch
# ---------------------------------------------------------------------------


def case_valid_unaffected_branch(workspace):
    snapshot = fixtures.base_snapshot()
    checks = []
    try:
        core.validate_snapshot(snapshot)
        checks.append(_check("gate_accepts_valid_snapshot", True, "no GateError"))
    except core.GateError as exc:
        checks.append(_check("gate_accepts_valid_snapshot", False, exc.code))

    internal = core.build_internal_view(snapshot)
    internal_ids = {c["claim_id"] for c in internal["claims"]}
    checks.append(
        _check(
            "internal_keeps_unaffected_and_private",
            {"claim-author", "claim-release", "claim-cross", "claim-mixed"} <= internal_ids,
            f"claims={sorted(internal_ids)}",
        )
    )
    public = core.build_public_view(snapshot)
    public_ids = {c["claim_id"] for c in public["claims"]}
    checks.append(
        _check(
            "public_keeps_public_branch",
            {"claim-author", "claim-release", "claim-cross"} <= public_ids,
            f"claims={sorted(public_ids)}",
        )
    )
    self_anchor_eligible = core.link_eligibility(snapshot).get(("person-lz", "s-profile-a"))
    checks.append(
        _check(
            "self_source_excerpt_is_anchor",
            bool(self_anchor_eligible and self_anchor_eligible[0]),
            f"eligibility={self_anchor_eligible}",
        )
    )
    return {
        "case_id": "valid-unaffected-branch",
        "title": "有效快照通过门禁，未受影响分支同时出现在内部与公共导出",
        "trace": [
            {"step": "before", "revision": 1, "claims": sorted(internal_ids)},
            {"step": "gate", "action": "validate_snapshot", "result": "accepted"},
            {"step": "after", "revision": 1, "public_claims": sorted(public_ids)},
        ],
        "observed_facts": [
            "有效合成快照通过结构与资格门禁",
            "内部导出保留公共与私有分支；公共导出保留未受影响的公共分支",
            "自述来源摘录被当作锚点，不需要额外身份依赖",
        ],
        "checks": checks,
    }


# ---------------------------------------------------------------------------
# Case 2: same-name source that is not linked is rejected (no name inference)
# ---------------------------------------------------------------------------


def case_same_name_unlinked(workspace):
    snapshot = copy.deepcopy(fixtures.base_snapshot())
    snapshot["claims"].append(
        {
            "claim_id": "claim-name",
            "person_id": "person-lz",
            "statement": "同名乐团主页把林舟列为作曲者。",
            "kind": "attributed_statement",
            "status": "supported",
            "support_evidence_ids": ["ev-name"],
            "refute_evidence_ids": [],
            "valid_from": None,
            "valid_to": None,
            "as_of": "2026-09-20",
        }
    )
    eligibility = core.link_eligibility(snapshot)
    same_name_linked = eligibility.get(("person-lz", "s-name-only"), (False,))[0]
    checks = [
        _expect_gate_error("same_name_claim_rejected", snapshot, "claim_source_unlinked"),
        _check(
            "no_name_based_linking",
            same_name_linked is False,
            "eligibility treats s-name-only as unlinked despite matching display name",
        ),
    ]
    return {
        "case_id": "same-name-unlinked-source",
        "title": "同名但未显式绑定的来源不能支持断言",
        "trace": [
            {"step": "before", "identity_links": len(snapshot["identity_links"])},
            {"step": "gate", "action": "claim-name via s-name-only", "result": "claim_source_unlinked"},
        ],
        "observed_facts": [
            "姓名相同不会产生身份链接（没有名称推断）",
            "使用未绑定来源的断言被门禁拒绝",
        ],
        "checks": checks,
    }


# ---------------------------------------------------------------------------
# Case 2b: rejected / candidate / disputed links are ineligible
# ---------------------------------------------------------------------------


def case_ineligible_link_states(workspace):
    checks = []
    for state in ("rejected", "candidate", "disputed"):
        snapshot = copy.deepcopy(fixtures.base_snapshot())
        for link in snapshot["identity_links"]:
            if link["person_id"] == "person-lz" and link["source_id"] == "s-news":
                link["state"] = state
        checks.append(_expect_gate_error(f"state_{state}_claim_rejected", snapshot, "claim_source_unlinked"))
        eligibility = core.link_eligibility(snapshot).get(("person-lz", "s-news"))
        checks.append(
            _check(f"state_{state}_ineligible", bool(eligibility and not eligibility[0]), str(eligibility))
        )

    # Regression: a cross-source link whose dependency is eligible must still
    # stay ineligible when its own state is not linked (old bug: it re-entered
    # the fixpoint through its eligible dependency).
    cross_rejected = copy.deepcopy(fixtures.base_snapshot())
    for link in cross_rejected["identity_links"]:
        if link["source_id"] == "s-cross":
            link["state"] = "rejected"
    cross_eligibility = core.link_eligibility(cross_rejected).get(("person-lz", "s-cross"))
    checks.append(
        _check(
            "rejected_cross_link_not_re_elevated",
            cross_eligibility is not None and cross_eligibility[0] is False,
            f"eligibility={cross_eligibility}",
        )
    )
    checks.append(
        _expect_gate_error("rejected_cross_link_claim_rejected", cross_rejected, "claim_source_unlinked")
    )
    return {
        "case_id": "ineligible-identity-link-states",
        "title": "rejected / candidate / disputed 身份链接不可用于支持",
        "trace": [
            {"step": "op", "action": "set link person-lz/s-news to rejected|candidate|disputed"},
            {"step": "gate", "action": "claim-release support", "result": "claim_source_unlinked"},
        ],
        "observed_facts": [
            "只有 linked 状态可用于支持断言",
            "rejected / candidate / disputed 链接保持不合格",
        ],
        "checks": checks,
    }


# ---------------------------------------------------------------------------
# Case 3/4: inaccessible source and forged excerpt
# ---------------------------------------------------------------------------


def case_inaccessible_source(workspace):
    snapshot = copy.deepcopy(fixtures.base_snapshot())
    snapshot["evidence"].append(
        {"evidence_id": "ev-blocked", "source_id": "s-blocked", "locator": "body:1", "excerpt": "不能引用的原文"}
    )
    snapshot["claims"].append(
        {
            "claim_id": "claim-blocked",
            "person_id": "person-lz",
            "statement": "不可读访谈声称的失败原因。",
            "kind": "attributed_statement",
            "status": "supported",
            "support_evidence_ids": ["ev-blocked"],
            "refute_evidence_ids": [],
            "valid_from": None,
            "valid_to": None,
            "as_of": "2026-09-20",
        }
    )
    return {
        "case_id": "inaccessible-source-attempted-quote",
        "title": "不可读来源（body=null）上的引用被拒绝",
        "trace": [
            {"step": "before", "source": "s-blocked", "fetch_status": "inaccessible", "body": None},
            {"step": "gate", "action": "quote s-blocked", "result": "source_inaccessible"},
        ],
        "observed_facts": ["fetch_status=inaccessible 的来源不能被引用", "null body 不能产生摘录"],
        "checks": [_expect_gate_error("inaccessible_quote_rejected", snapshot, "source_inaccessible")],
    }


def case_forged_excerpt(workspace):
    snapshot = copy.deepcopy(fixtures.base_snapshot())
    snapshot["evidence"].append(
        {"evidence_id": "ev-forged", "source_id": "s-forged", "locator": "body:9", "excerpt": "从未出现过的句子"}
    )
    snapshot["claims"].append(
        {
            "claim_id": "claim-forged",
            "person_id": "person-lz",
            "statement": "伪造摘录支持的断言。",
            "kind": "attributed_statement",
            "status": "supported",
            "support_evidence_ids": ["ev-forged"],
            "refute_evidence_ids": [],
            "valid_from": None,
            "valid_to": None,
            "as_of": "2026-09-20",
        }
    )
    return {
        "case_id": "forged-excerpt",
        "title": "摘录不在合成正文中时被拒绝",
        "trace": [
            {"step": "before", "source": "s-forged", "body": "该页面只有普通陈述。"},
            {"step": "gate", "action": "quote absent sentence", "result": "excerpt_not_found"},
        ],
        "observed_facts": ["摘录必须是合成来源正文的精确子串"],
        "checks": [_expect_gate_error("forged_excerpt_rejected", snapshot, "excerpt_not_found")],
    }


# ---------------------------------------------------------------------------
# Case 5: broken references / duplicate IDs / unknown policy / person mismatch
# ---------------------------------------------------------------------------


def case_broken_reference(workspace):
    checks = []

    broken_claim = copy.deepcopy(fixtures.base_snapshot())
    broken_claim["claims"][0]["support_evidence_ids"] = ["ev-missing"]
    checks.append(_expect_gate_error("broken_claim_ref", broken_claim, "unknown_reference"))

    broken_link = copy.deepcopy(fixtures.base_snapshot())
    broken_link["identity_links"][0]["basis_evidence_ids"] = ["ev-missing"]
    checks.append(_expect_gate_error("broken_identity_basis", broken_link, "unknown_reference"))

    broken_event = copy.deepcopy(fixtures.base_snapshot())
    broken_event["events"].append(
        {
            "event_id": "event-bad",
            "person_id": "person-lz",
            "occurred_at": None,
            "recorded_at": None,
            "action_claim_ids": ["claim-missing"],
            "outcome_claim_ids": [],
            "context": "",
            "unknowns": [],
        }
    )
    checks.append(_expect_gate_error("broken_event_ref", broken_event, "unknown_reference"))

    broken_hypothesis = copy.deepcopy(fixtures.base_snapshot())
    broken_hypothesis["behavior_hypotheses"].append(
        {
            "hypothesis_id": "hyp-bad",
            "person_id": "person-lz",
            "statement": "引用不存在事件。",
            "support_event_ids": ["event-missing"],
            "counter_event_ids": [],
            "alternatives": [],
            "falsifier": "",
            "status": "hypothesis",
        }
    )
    checks.append(_expect_gate_error("broken_hypothesis_ref", broken_hypothesis, "unknown_reference"))
    return {
        "case_id": "broken-references",
        "title": "断裂外键（claim/identity/event/hypothesis）被拒绝",
        "trace": [{"step": "gate", "action": "inject dangling foreign keys", "result": "unknown_reference"}],
        "observed_facts": ["所有外键（含人物/档案身份证据、事件与假设边）都必须存在"],
        "checks": checks,
    }


def case_duplicate_and_policy(workspace):
    checks = []

    duplicate = copy.deepcopy(fixtures.base_snapshot())
    duplicate["sources"].append(copy.deepcopy(duplicate["sources"][0]))
    checks.append(_expect_gate_error("duplicate_source_id", duplicate, "duplicate_id"))

    unknown_policy = copy.deepcopy(fixtures.base_snapshot())
    unknown_policy["sources"][0]["export_policy"] = "mystery"
    checks.append(_expect_gate_error("unknown_policy_fails_closed", unknown_policy, "unknown_export_policy"))

    mismatch = copy.deepcopy(fixtures.base_snapshot())
    mismatch["events"].append(
        {
            "event_id": "event-mismatch",
            "person_id": "person-lz",
            "occurred_at": None,
            "recorded_at": None,
            "action_claim_ids": ["claim-wang"],
            "outcome_claim_ids": [],
            "context": "",
            "unknowns": [],
        }
    )
    checks.append(_expect_gate_error("cross_person_event_claim", mismatch, "claim_person_mismatch"))
    return {
        "case_id": "duplicate-id-and-unknown-policy",
        "title": "重复 ID、未知权限枚举与跨人物 claim 关联被拒绝",
        "trace": [{"step": "gate", "action": "inject malformed variants", "result": "rejected"}],
        "observed_facts": [
            "ID 必须唯一",
            "未知 export_policy 失败关闭",
            "event 不得引用他人 claim（人物对应关系）",
        ],
        "checks": checks,
    }


# ---------------------------------------------------------------------------
# Case 6: leaf identity revocation cascades through claim/event/hypothesis/coverage
# ---------------------------------------------------------------------------


def case_leaf_revocation_cascade(workspace):
    snapshot = fixtures.base_snapshot()
    store = _new_store(workspace, "leaf.sqlite")
    try:
        store.add_revision(snapshot)
        revocation = core.apply_identity_revocation(snapshot, "person-lz", "s-news")
        store.add_revision(revocation)
        current = store.read_current("run-probe-001")
        internal = core.build_internal_view(current)
        internal_ids = {c["claim_id"] for c in internal["claims"]}
        event_ids = {e["event_id"] for e in internal["events"]}
        hyp_ids = {h["hypothesis_id"] for h in internal["behavior_hypotheses"]}
        coverage = {entry["question"]: entry for entry in internal["coverage"]}

        checks = [
            _check(
                "dependent_claim_invalidated",
                "claim-release" not in internal_ids
                and any(
                    c.get("invalidated_reason")
                    for c in current["claims"]
                    if c["claim_id"] == "claim-release"
                ),
                f"claims={sorted(internal_ids)}",
            ),
            _check("dependent_event_invalidated", "event-release" not in event_ids, f"events={sorted(event_ids)}"),
            _check("dependent_hypothesis_invalidated", "hyp-release" not in hyp_ids, f"hypotheses={sorted(hyp_ids)}"),
            _check(
                "dependent_coverage_blocked",
                coverage["发布稿记录了什么？"]["status"] == "blocked",
                f"coverage={coverage['发布稿记录了什么？']}",
            ),
            _check(
                "unrelated_branch_preserved",
                {"claim-author"} <= internal_ids and "event-author" in event_ids and "hyp-author" in hyp_ids,
                f"claims={sorted(internal_ids)}",
            ),
            _check(
                "new_revision_current_rejected_state",
                any(
                    link["state"] == "rejected"
                    for link in current["identity_links"]
                    if link["source_id"] == "s-news"
                ),
                "revoked link exported as rejected state",
            ),
        ]
        # The rewritten revision must itself be a valid current report.
        try:
            core.validate_snapshot(current)
            checks.append(_check("recomputed_revision_gate_valid", True, "no GateError"))
        except core.GateError as exc:
            checks.append(_check("recomputed_revision_gate_valid", False, exc.code))

        trace = [
            {"step": "before", "revision": 1, "claims": sorted({c["claim_id"] for c in snapshot["claims"]})},
            {"step": "op", "action": "revoke identity link person-lz/s-news", "state": "rejected"},
            {"step": "after", "revision": current["revision"], "claims": sorted(internal_ids)},
        ]
    finally:
        store.close()
    return {
        "case_id": "leaf-identity-revocation-cascade",
        "title": "叶子身份撤销沿 claim→event→hypothesis→coverage 级联失效，旁支保留",
        "trace": trace,
        "observed_facts": [
            "撤销来源身份后其断言失效",
            "事件、行为假设与已回答覆盖随之失效",
            "不依赖被撤销来源的旁支完整保留",
        ],
        "checks": checks,
    }


# ---------------------------------------------------------------------------
# Case 7: cross-source identity basis revocation
# ---------------------------------------------------------------------------


def case_cross_source_basis_revocation(workspace):
    snapshot = fixtures.base_snapshot()
    before = core.link_eligibility(snapshot).get(("person-lz", "s-cross"))
    store = _new_store(workspace, "cross.sqlite")
    try:
        store.add_revision(snapshot)
        revocation = core.apply_identity_revocation(snapshot, "person-lz", "s-news")
        store.add_revision(revocation)
        current = store.read_current("run-probe-001")
    finally:
        store.close()
    after = core.link_eligibility(current).get(("person-lz", "s-cross"))
    internal = core.build_internal_view(current)
    internal_ids = {c["claim_id"] for c in internal["claims"]}
    checks = [
        _check("cross_basis_was_eligible", bool(before and before[0]), f"before={before}"),
        _check(
            "cross_basis_invalidated_by_dependency",
            after is not None and after[0] is False,
            f"after={after}",
        ),
        _check(
            "cross_dependent_claim_invalidated",
            "claim-cross" not in internal_ids,
            f"claims={sorted(internal_ids)}",
        ),
        _check("public_branch_preserved", "claim-author" in internal_ids, f"claims={sorted(internal_ids)}"),
    ]
    return {
        "case_id": "cross-source-identity-basis-revocation",
        "title": "跨来源身份依据被撤销后，依赖它的身份链接失效",
        "trace": [
            {"step": "before", "link": "person-lz/s-cross", "eligibility": before},
            {"step": "op", "action": "revoke basis source person-lz/s-news"},
            {"step": "after", "link": "person-lz/s-cross", "eligibility": after},
        ],
        "observed_facts": [
            "跨来源身份依据撤销会传播到依赖链接",
            "依赖失效链接的断言从当前导出移除",
            "独立锚点分支保留",
        ],
        "checks": checks,
    }


# ---------------------------------------------------------------------------
# Case 8: identity cycle rejection
# ---------------------------------------------------------------------------


def case_identity_cycle(workspace):
    unanchored = fixtures.cycle_snapshot()
    anchored = fixtures.anchored_chain_snapshot()
    mixed = fixtures.mixed_basis_cycle_snapshot()
    checks = [_expect_gate_error("unanchored_cycle_rejected", unanchored, "identity_cycle")]
    eligibility = core.link_eligibility(unanchored)
    checks.append(
        _check(
            "cycle_links_ineligible",
            all(not eligibility[key][0] for key in eligibility),
            f"eligibility={eligibility}",
        )
    )
    checks.append(
        _expect_gate_error("mixed_basis_cycle_rejected", mixed, "identity_cycle")
    )
    try:
        core.validate_snapshot(anchored)
        checks.append(_check("independent_anchor_chain_accepted", True, "pure self-source seed resolves Y"))
    except core.GateError as exc:
        checks.append(_check("independent_anchor_chain_accepted", False, exc.code))
    anchored_eligibility = core.link_eligibility(anchored)
    checks.append(
        _check(
            "anchor_chain_eligible",
            anchored_eligibility.get(("person-lz", "s-cycle-y"), (False,))[0]
            and anchored_eligibility.get(("person-lz", "s-cycle-x"), (False,))[0],
            f"eligibility={anchored_eligibility}",
        )
    )
    return {
        "case_id": "identity-cycle-rejection",
        "title": "无独立种子的跨来源身份循环被拒绝；纯自述锚点可解析依赖",
        "trace": [
            {"step": "gate", "action": "X basis<-Y, Y basis<-X", "result": "identity_cycle"},
            {"step": "gate", "action": "X self excerpt + required cross Y", "result": "identity_cycle"},
            {"step": "gate", "action": "X pure self anchor, Y cross<-X", "result": "accepted"},
        ],
        "observed_facts": [
            "无独立种子的跨来源身份循环被拒绝",
            "自述摘录不能免除必需的跨来源依赖",
            "纯自述锚点是无前提的种子，可解析依赖它的链接",
        ],
        "checks": checks,
    }


# ---------------------------------------------------------------------------
# Case 9: superseded revision read/export after reopen; malformed cannot supersede
# ---------------------------------------------------------------------------


def case_superseded_revision(workspace):
    path = os.path.join(workspace, "revisions.sqlite")
    first = fixtures.base_snapshot()
    store = core.SnapshotStore(path)
    try:
        store.add_revision(first)
        second = core.apply_identity_revocation(first, "person-lz", "s-news")
        store.add_revision(second)
    finally:
        store.close()

    checks = []
    # Reconnect: a fresh process-like connection must still distinguish status.
    reopened = core.SnapshotStore(path)
    try:
        try:
            reopened.read_revision("run-probe-001", 1)
            checks.append(_check("superseded_read_rejected_after_reopen", False, "returned stale revision"))
        except core.RevisionSuperseded as exc:
            checks.append(
                _check(
                    "superseded_read_rejected_after_reopen",
                    exc.superseded_by == 2,
                    f"superseded_by={exc.superseded_by}",
                )
            )
        current = reopened.read_current("run-probe-001")
        checks.append(_check("current_is_revision_2", current["revision"] == 2, f"revision={current['revision']}"))

        stale = core.export_report(reopened, "run-probe-001", revision=1, fmt="json")
        checks.append(
            _check(
                "superseded_export_explicit_error",
                not stale["ok"] and stale["errors"][0]["code"] == "revision_superseded",
                json.dumps(stale["errors"], ensure_ascii=False),
            )
        )

        malformed = copy.deepcopy(first)
        malformed["revision"] = 3
        malformed["supersedes"] = 2
        malformed["sources"].append(copy.deepcopy(malformed["sources"][0]))
        try:
            reopened.add_revision(malformed)
            checks.append(_check("malformed_revision_rejected", False, "malformed revision accepted"))
        except core.GateError as exc:
            checks.append(_check("malformed_revision_rejected", exc.code == "duplicate_id", exc.code))
        checks.append(
            _check(
                "malformed_did_not_supersede",
                reopened.read_current("run-probe-001")["revision"] == 2,
                "current revision unchanged after malformed write",
            )
        )

        try:
            with reopened.conn:
                reopened.conn.execute(
                    "UPDATE revisions SET payload=? WHERE run_id=? AND revision=2",
                    ("{}", "run-probe-001"),
                )
            checks.append(_check("payload_immutable", False, "payload UPDATE was allowed"))
        except sqlite3.DatabaseError as exc:
            checks.append(_check("payload_immutable", True, str(exc)))
        checks.append(
            _check(
                "statuses_recorded",
                reopened.revisions("run-probe-001") == [(1, "superseded"), (2, "current")],
                str(reopened.revisions("run-probe-001")),
            )
        )
    finally:
        reopened.close()
    return {
        "case_id": "superseded-revision-after-reopen",
        "title": "重连后旧修订返回 revision_superseded；畸形修订不能取代有效报告",
        "trace": [
            {"step": "write", "revision": 1, "status": "current"},
            {"step": "write", "revision": 2, "status": "current", "revision_1": "superseded"},
            {"step": "reopen", "action": "read revision 1", "result": "revision_superseded(superseded_by=2)"},
            {"step": "write", "revision": 3, "action": "duplicate id", "result": "rejected, revision 2 remains current"},
        ],
        "observed_facts": [
            "SQLite 保存不可变快照及 current/superseded 状态",
            "重连后仍明确区分旧修订",
            "畸形修订在事务前失败，不改变有效报告",
            "payload 不可被 UPDATE 修改",
        ],
        "checks": checks,
    }


# ---------------------------------------------------------------------------
# Case 10: public/private mixed support and private-only person/profile
# ---------------------------------------------------------------------------


def case_public_private(workspace):
    snapshot = fixtures.base_snapshot()
    public = core.build_public_view(snapshot)
    public_json = core.render_json(public)
    public_md = core.render_markdown(public)
    public_ids = {c["claim_id"] for c in public["claims"]}
    public_person_ids = {p["person_id"] for p in public["people_index"]}
    source_ids = {s["source_id"] for s in public["sources"]}
    evidence_ids = {e["evidence_id"] for e in public["evidence"]}
    unknown_ids = {u["unknown_id"] for u in public["unknowns"] if isinstance(u, dict)}

    private_strings = [
        "内部合同档案（合成）",
        "内部档案：林舟合同细节 A-17。",
        "王五（合成私有）",
        "https://example.org/private/wang",
        "内部人物页：研究员王五，负责机密项目。",
    ]
    leaked = [s for s in private_strings if s in public_json or s in public_md]

    checks = [
        _check("mixed_support_claim_excluded", "claim-mixed" not in public_ids, f"claims={sorted(public_ids)}"),
        _check("private_source_omitted", "s-mixed-private" not in source_ids, f"sources={sorted(source_ids)}"),
        _check("private_evidence_omitted", "ev-private" not in evidence_ids, f"evidence={sorted(evidence_ids)}"),
        _check("private_only_person_omitted", "person-wang" not in public_person_ids, str(sorted(public_person_ids))),
        _check("private_unknown_omitted", "u-private" not in unknown_ids, str(sorted(unknown_ids))),
        _check("public_unknown_preserved", "u-release" in unknown_ids, str(sorted(unknown_ids))),
        _check("private_labels_not_leaked", not leaked, f"leaked={leaked}"),
        _check(
            "canonical_urls_preserved",
            "https://example.org/s-profile-a" in public_md
            and "https://example.org/s-news" in public_json,
            "public canonical URLs survive the filter",
        ),
        _check("no_private_patterns", not core.scan_for_private_material(public_json + public_md), "clean"),
    ]
    return {
        "case_id": "public-private-mixed-support",
        "title": "混合公私支持被保守排除；私有来源、人物与档案元数据不进入公共导出",
        "trace": [
            {"step": "before", "claims": ["claim-mixed", "claim-wang", "claim-release"]},
            {"step": "filter", "action": "build_public_view"},
            {"step": "after", "claims": sorted(public_ids), "sources": sorted(source_ids)},
        ],
        "observed_facts": [
            "含私有支持的断言被整体排除而非声称独立支持",
            "仅私有身份的人物与档案从公共导出消失",
            "受限覆盖与未验证未知不泄露隐藏材料存在",
        ],
        "checks": checks,
    }


# ---------------------------------------------------------------------------
# Case 11: renderer parity and escaping
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Case 10: mixed self+cross basis cannot waive cross dependencies
# ---------------------------------------------------------------------------


def case_mixed_basis_revocation(workspace):
    snapshot = fixtures.mixed_basis_snapshot()
    before = core.link_eligibility(snapshot).get(("person-lz", "s-cross"))
    revoked = core.apply_identity_revocation(snapshot, "person-lz", "s-news")
    after = core.link_eligibility(revoked).get(("person-lz", "s-cross"))
    internal = core.build_internal_view(revoked)
    ids = {c["claim_id"] for c in internal["claims"]}
    checks = [
        _check("mixed_basis_eligible_before", bool(before and before[0]), f"before={before}"),
        _check(
            "mixed_basis_cross_dependency_required",
            after is not None and after[0] is False,
            f"after={after}",
        ),
        _check("mixed_basis_dependent_claim_invalidated", "claim-cross" not in ids, str(sorted(ids))),
        _check("mixed_basis_unrelated_branch_preserved", "claim-author" in ids, str(sorted(ids))),
    ]
    return {
        "case_id": "mixed-basis-requires-cross-dependency",
        "title": "自述依据不能免除必需的跨来源身份依赖",
        "trace": [
            {"step": "before", "link": "person-lz/s-cross basis=[ev-news-ref, ev-cross]", "eligibility": before},
            {"step": "op", "action": "revoke basis source s-news"},
            {"step": "after", "link": "person-lz/s-cross", "eligibility": after},
        ],
        "observed_facts": [
            "混合自述+跨来源依据仍要求所有声明的跨来源依赖合格",
            "跨来源依赖失效时依赖链接与断言一并失效",
        ],
        "checks": checks,
    }


# ---------------------------------------------------------------------------
# Case 11: public permission closure over the public-permitted subgraph
# ---------------------------------------------------------------------------


def case_public_permission_closure(workspace):
    snapshot = fixtures.permission_chain_snapshot()
    before_public = core.build_public_view(snapshot)
    before_ids = {c["claim_id"] for c in before_public["claims"]}

    for source in snapshot["sources"]:
        if source["source_id"] == "s-news":
            source["export_policy"] = "private_local"
    public = core.build_public_view(snapshot)
    ids = {c["claim_id"] for c in public["claims"]}
    link_sources = {link["source_id"] for link in public["identity_links"]}
    evidence_ids = {e["evidence_id"] for e in public["evidence"]}
    evidence_by_id = {e["evidence_id"]: e for e in public["evidence"]}
    source_ids = {s["source_id"] for s in public["sources"]}

    dangling = []
    for link in public["identity_links"]:
        for evidence_id in link["basis_evidence_ids"]:
            if evidence_id not in evidence_ids:
                dangling.append(f"link {link['source_id']} -> {evidence_id}")
    for claim in public["claims"]:
        for evidence_id in list(claim["support_evidence_ids"]) + list(claim["refute_evidence_ids"]):
            if evidence_id not in evidence_ids:
                dangling.append(f"claim {claim['claim_id']} -> {evidence_id}")
    for person in public["people_index"]:
        for evidence_id in person["identity_evidence_ids"]:
            if evidence_id not in evidence_ids:
                dangling.append(f"person {person['person_id']} -> {evidence_id}")
        for profile in person["profile_links"]:
            for evidence_id in profile["evidence_ids"]:
                if evidence_id not in evidence_ids:
                    dangling.append(f"profile -> {evidence_id}")
    for evidence in public["evidence"]:
        if evidence["source_id"] not in source_ids:
            dangling.append(f"evidence {evidence['evidence_id']} -> {evidence['source_id']}")

    checks = [
        _check(
            "chain_public_before_closure",
            {"claim-cross", "claim-hop"} <= before_ids,
            f"before={sorted(before_ids)}",
        ),
        _check("direct_private_dependency_excluded", "claim-release" not in ids, str(sorted(ids))),
        _check("two_hop_dependency_excluded", "claim-cross" not in ids, str(sorted(ids))),
        _check("three_hop_dependency_excluded", "claim-hop" not in ids, str(sorted(ids))),
        _check("public_branch_preserved", "claim-author" in ids, str(sorted(ids))),
        _check(
            "restricted_links_absent",
            not ({"s-news", "s-cross", "s-hop"} & link_sources),
            f"links={sorted(link_sources)}",
        ),
        _check("no_dangling_public_pointers", not dangling, f"dangling={dangling}"),
    ]
    return {
        "case_id": "public-permission-fixed-point",
        "title": "公共身份资格在仅公共子图上重算到不动点，多跳受限依赖不泄漏",
        "trace": [
            {"step": "before", "action": "s-news public", "public_claims": sorted(before_ids)},
            {"step": "op", "action": "s-news export_policy=private_local"},
            {"step": "after", "public_claims": sorted(ids), "link_sources": sorted(link_sources)},
        ],
        "observed_facts": [
            "公共源经受限中间来源得到的身份支持不再合格",
            "二跳与三跳受限依赖的断言都不进入公共导出",
            "公共导出没有悬空身份/证据指针",
        ],
        "checks": checks,
    }


# ---------------------------------------------------------------------------
# Case 12: explicit public provenance for text-bearing fields
# ---------------------------------------------------------------------------


def case_provenance_controls(workspace):
    snapshot = fixtures.provenance_snapshot()
    public = core.build_public_view(snapshot)
    internal = core.build_internal_view(snapshot)
    public_json = core.render_json(public)
    public_md = core.render_markdown(public)
    public_text = public_json + public_md
    internal_json = core.render_json(internal)

    negatives = [
        "无来源标注的上下文。",
        "无来源标注的事件未知。",
        "混合来源上下文。",
        "无来源标注的假设。",
        "无来源标注的否定条件。",
        "无来源标注的问题？",
        "无来源标注的原因。",
        "无来源标注的未知。",
        "缺来源的替代解释。",
        "缺来源的否定条件。",
    ]
    leaked = [text for text in negatives if text in public_text]

    checks = [
        _check("missing_and_mixed_provenance_omitted", not leaked, f"leaked={leaked}"),
        _check(
            "negative_controls_present_internally",
            all(text in internal_json for text in negatives),
            "internal view keeps unprovenanced nodes for audit",
        ),
        _check("public_event_context_positive", "公开主页陈述。" in public_text, ""),
        _check("public_event_unknown_positive", "作者长期活动的完整时间线未知。" in public_text, ""),
        _check("public_falsifier_positive", "主页被证明属于他人。" in public_text, ""),
        _check("public_partial_hypothesis_positive", "部分来源标注的假设。" in public_text, ""),
        _check("public_alternative_positive", "有来源的替代解释。" in public_text, ""),
        _check("public_coverage_positive", "能否判断长期维护能力？" in public_text, ""),
        _check("public_unknown_positive", "发布后的长期维护情况未确认。" in public_text, ""),
    ]

    # Missing display-name provenance must remove the whole person from public.
    no_name = copy.deepcopy(fixtures.base_snapshot())
    for person in no_name["people_index"]:
        if person["person_id"] == "person-lz":
            person.pop("display_name_provenance", None)
    no_name_public = core.build_public_view(no_name)
    checks.append(
        _check(
            "missing_display_name_provenance_omits_person",
            not any(p["person_id"] == "person-lz" for p in no_name_public["people_index"]),
            "person omitted when display-name provenance is missing",
        )
    )
    return {
        "case_id": "public-provenance-controls",
        "title": "文本字段需要显式全公共来源；缺失或受限来源的文本一律省略",
        "trace": [
            {"step": "before", "action": "build public/internal from provenance fixture"},
            {"step": "after", "negatives_leaked": leaked},
        ],
        "observed_facts": [
            "缺少或混合来源的文本字段在公共导出被省略",
            "显式全公共来源的上下文、未知、覆盖与假设文本保留",
            "声明来源是作者输入而非语义真值（本探针只检查可达权限）",
        ],
        "checks": checks,
    }


# ---------------------------------------------------------------------------
# Case 13: claim status/kind enums and required dependencies
# ---------------------------------------------------------------------------


def case_claim_requirements(workspace):
    checks = []

    no_support = copy.deepcopy(fixtures.base_snapshot())
    no_support["claims"].append(
        {
            "claim_id": "claim-nosupport",
            "person_id": "person-lz",
            "statement": "无支持证据的已支持断言。",
            "kind": "factual",
            "status": "supported",
            "support_evidence_ids": [],
            "refute_evidence_ids": [],
            "valid_from": None,
            "valid_to": None,
            "as_of": "2026-09-20",
        }
    )
    checks.append(_expect_gate_error("supported_without_support_rejected", no_support, "claim_missing_support"))

    insufficient = copy.deepcopy(fixtures.base_snapshot())
    insufficient["claims"].append(
        {
            "claim_id": "claim-insufficient",
            "person_id": "person-lz",
            "statement": "证据不足的断言。",
            "kind": "inference",
            "status": "insufficient_evidence",
            "support_evidence_ids": [],
            "refute_evidence_ids": [],
            "valid_from": None,
            "valid_to": None,
            "as_of": "2026-09-20",
        }
    )
    try:
        core.validate_snapshot(insufficient)
        checks.append(_check("insufficient_evidence_allowed", True, "no upgrade"))
    except core.GateError as exc:
        checks.append(_check("insufficient_evidence_allowed", False, exc.code))

    bad_kind = copy.deepcopy(fixtures.base_snapshot())
    bad_kind["claims"][0]["kind"] = "vibe"
    checks.append(_expect_gate_error("invalid_claim_kind_rejected", bad_kind, "invalid_claim_kind"))

    bad_status = copy.deepcopy(fixtures.base_snapshot())
    bad_status["claims"][0]["status"] = "probably"
    checks.append(_expect_gate_error("invalid_claim_status_rejected", bad_status, "invalid_claim_status"))

    bad_revision = copy.deepcopy(fixtures.base_snapshot())
    bad_revision["revision"] = 0
    checks.append(_expect_gate_error("invalid_revision_rejected", bad_revision, "invalid_revision"))

    bad_link = copy.deepcopy(fixtures.base_snapshot())
    bad_link["identity_links"][0]["state"] = "maybe"
    checks.append(_expect_gate_error("invalid_link_state_rejected", bad_link, "invalid_link_state"))

    bad_coverage = copy.deepcopy(fixtures.base_snapshot())
    bad_coverage["coverage"][0]["status"] = "almost"
    checks.append(_expect_gate_error("invalid_coverage_status_rejected", bad_coverage, "invalid_coverage_status"))
    return {
        "case_id": "claim-status-requirements",
        "title": "已知 claim 状态必须有声明的依赖；枚举与修订号失败关闭",
        "trace": [{"step": "gate", "action": "inject invalid claim/state variants", "result": "rejected"}],
        "observed_facts": [
            "supported 断言不能没有支持证据",
            "insufficient_evidence 无证据被允许且不被升级",
            "claim kind/status、链接状态、coverage 状态与 revision 使用封闭枚举",
        ],
        "checks": checks,
    }


# ---------------------------------------------------------------------------
# Case 14: audience/format enum validation before data access
# ---------------------------------------------------------------------------


def case_export_enums(workspace):
    store = core.SnapshotStore(":memory:")
    try:
        store.add_revision(fixtures.base_snapshot())
        bad_audience = core.export_report(store, "run-probe-001", audience="publci")
        bad_format = core.export_report(store, "run-probe-001", fmt="markdwn")
        public_ok = core.export_report(store, "run-probe-001", audience="public", fmt="json")
        internal_ok = core.export_report(store, "run-probe-001", audience="internal", fmt="markdown")
    finally:
        store.close()
    checks = [
        _check(
            "unknown_audience_rejected",
            not bad_audience["ok"] and bad_audience["errors"][0]["code"] == "invalid_audience",
            json.dumps(bad_audience, ensure_ascii=False),
        ),
        _check(
            "unknown_format_rejected",
            not bad_format["ok"] and bad_format["errors"][0]["code"] == "invalid_format",
            json.dumps(bad_format, ensure_ascii=False),
        ),
        _check("public_export_ok", public_ok["ok"], ""),
        _check(
            "internal_not_redefined",
            internal_ok["ok"] and "内部合同档案（合成）" in internal_ok["content"],
            "explicit internal audience sees internal nodes",
        ),
    ]
    return {
        "case_id": "export-enum-validation",
        "title": "未知 audience/format 在数据访问前失败关闭，不被静默当成 internal/Markdown",
        "trace": [{"step": "export", "action": "audience=publci, fmt=markdwn", "result": "invalid_audience/invalid_format"}],
        "observed_facts": [
            "audience 与 format 使用封闭枚举",
            "拼写错误返回明确错误而非静默降级",
        ],
        "checks": checks,
    }


def case_renderer_parity(workspace):
    snapshot = fixtures.base_snapshot()
    before = copy.deepcopy(snapshot)
    checks = []
    for audience, builder in (("internal", core.build_internal_view), ("public", core.build_public_view)):
        view = builder(snapshot)
        view_json = core.render_json(view)
        view_md = core.render_markdown(view)
        parsed = json.loads(view_json)
        claim_ids = {c["claim_id"] for c in parsed["claims"]}
        missing = [cid for cid in claim_ids if cid not in view_md]
        status_missing = [
            c["claim_id"]
            for c in parsed["claims"]
            if c["status"] and c["claim_id"] not in view_md
        ]
        anchors_missing = [
            p["report_anchor"]
            for p in parsed["people_index"]
            if f'id="{p["report_anchor"]}"' not in view_md
        ]
        urls_missing = [
            s["canonical_url"] for s in parsed["sources"] if s["canonical_url"] not in view_md
        ]
        checks.append(_check(f"{audience}_claim_ids_shared", not missing, f"missing={missing}"))
        checks.append(_check(f"{audience}_statuses_shared", not status_missing, str(status_missing)))
        checks.append(_check(f"{audience}_anchors_shared", not anchors_missing, str(anchors_missing)))
        checks.append(_check(f"{audience}_urls_shared", not urls_missing, str(urls_missing)))
        checks.append(
            _check(
                f"{audience}_metadata_shared",
                f"revision {parsed['revision']}" in view_md and parsed["as_of"] in view_md,
                "revision/as_of present in Markdown",
            )
        )

    hostile = fixtures.hostile_snapshot()
    hostile_public = core.build_public_view(hostile)
    hostile_md = core.render_markdown(hostile_public)
    checks.append(_check("html_escaped", "&lt;script&gt;" in hostile_md and "<script>" not in hostile_md, ""))
    checks.append(_check("img_escaped", "&lt;img" in hostile_md and "<img" not in hostile_md, ""))
    checks.append(_check("unsafe_url_not_linked", "](javascript:" not in hostile_md, ""))
    checks.append(_check("safe_url_paren_encoded", "a%28b%29c" in hostile_md, ""))
    checks.append(_check("rendering_is_pure", snapshot == before, "render did not mutate stored snapshot"))
    return {
        "case_id": "renderer-parity",
        "title": "JSON 与 Markdown 共享同一过滤快照，渲染纯净且转义不安全内容",
        "trace": [
            {"step": "before", "snapshot_revision": snapshot["revision"]},
            {"step": "render", "action": "json + markdown from same view"},
            {"step": "after", "snapshot_unchanged": snapshot == before},
        ],
        "observed_facts": [
            "两种格式的 claim/evidence ID、状态、as_of、revision、人物锚点与 canonical URL 一致",
            "HTML 与不安全链接被转义，渲染不修改状态、不调用 provider",
        ],
        "checks": checks,
    }


# ---------------------------------------------------------------------------
# Case 15: Markdown renders material per-node fields (item 7)
# ---------------------------------------------------------------------------


def case_renderer_material_fields(workspace):
    snapshot = fixtures.counterevidence_snapshot()
    public = core.build_public_view(snapshot)
    parsed = json.loads(core.render_json(public))
    markdown = core.render_markdown(public)

    claims_missing_refute = []
    claims_missing_times = []
    for claim in parsed["claims"]:
        for evidence_id in claim["support_evidence_ids"]:
            if evidence_id not in markdown:
                claims_missing_refute.append(f"support:{claim['claim_id']}:{evidence_id}")
        for evidence_id in claim["refute_evidence_ids"]:
            if evidence_id not in markdown:
                claims_missing_refute.append(f"refute:{claim['claim_id']}:{evidence_id}")
        for field in ("valid_from", "valid_to"):
            value = claim.get(field)
            if value and value not in markdown:
                claims_missing_times.append(f"{claim['claim_id']}:{field}")

    events_missing = []
    for event in parsed["events"]:
        for claim_id in list(event["action_claim_ids"]) + list(event["outcome_claim_ids"]):
            if claim_id not in markdown:
                events_missing.append(f"{event['event_id']}:{claim_id}")
        for unknown in event.get("unknowns", []):
            text = unknown.get("text") if isinstance(unknown, dict) else unknown
            if text and text not in markdown:
                events_missing.append(f"{event['event_id']}:unknown:{text}")

    hypotheses_missing = []
    for hypothesis in parsed["behavior_hypotheses"]:
        for event_id in list(hypothesis["support_event_ids"]) + list(hypothesis["counter_event_ids"]):
            if event_id not in markdown:
                hypotheses_missing.append(f"{hypothesis['hypothesis_id']}:{event_id}")
        if hypothesis.get("falsifier") and hypothesis["falsifier"] not in markdown:
            hypotheses_missing.append(f"{hypothesis['hypothesis_id']}:falsifier")
        for alternative in hypothesis.get("alternatives", []):
            if alternative not in markdown:
                hypotheses_missing.append(f"{hypothesis['hypothesis_id']}:alternative:{alternative}")

    checks = [
        _check(
            "contested_claim_present",
            "claim-contested" in markdown
            and "claim-contested" in {c["claim_id"] for c in parsed["claims"]},
            "",
        ),
        _check("support_and_refute_labels", "support" in markdown and "refute" in markdown, ""),
        _check("claim_refs_rendered", not claims_missing_refute, str(claims_missing_refute)),
        _check("claim_validity_rendered", not claims_missing_times, str(claims_missing_times)),
        _check("event_outcomes_and_unknowns_rendered", not events_missing, str(events_missing)),
        _check("hypothesis_fields_rendered", not hypotheses_missing, str(hypotheses_missing)),
        _check("counter_label_rendered", "counter=" in markdown, ""),
        _check("alternatives_label_rendered", "alternatives=" in markdown, ""),
        _check("falsifier_label_rendered", "falsifier=" in markdown, ""),
        _check("outcome_label_rendered", "outcome=claim-release" in markdown, ""),
    ]
    return {
        "case_id": "renderer-material-fields",
        "title": "断言反证/有效期、事件结果与未知、假设反事件/替代解释/否证条件都进入 Markdown",
        "trace": [{"step": "render", "action": "counterevidence snapshot -> public json + markdown"}],
        "observed_facts": [
            "Markdown 与 JSON 对每个节点暴露相同的支持/反证与不确定性字段",
            "支持与反证、支持事件与反事件使用不同标签",
        ],
        "checks": checks,
    }


# ---------------------------------------------------------------------------
# Case 16: legal source withdrawal vs failed retrieval
# ---------------------------------------------------------------------------


def case_source_withdrawal(workspace):
    snapshot = fixtures.base_snapshot()
    path = os.path.join(workspace, "withdraw.sqlite")
    store = core.SnapshotStore(path)
    try:
        store.add_revision(snapshot)
        withdrawn = core.apply_source_withdrawal(snapshot, "s-news")
        store.add_revision(withdrawn)
    finally:
        store.close()

    checks = [
        _check(
            "withdrawal_creates_new_revision",
            withdrawn["revision"] == 2 and withdrawn["supersedes"] == 1,
            f"revision={withdrawn['revision']} supersedes={withdrawn['supersedes']}",
        )
    ]
    withdrawn_excerpts = [
        "软件作者林舟发布 Lantern 2.0。",
        "本文引用主页 https://example.org/people/lz7 。",
    ]

    # Reopen and prove the old export is rejected while the new one is current.
    reopened = core.SnapshotStore(path)
    try:
        try:
            reopened.read_revision("run-probe-001", 1)
            checks.append(_check("old_revision_rejected_after_withdraw", False, "stale revision returned"))
        except core.RevisionSuperseded as exc:
            checks.append(
                _check(
                    "old_revision_rejected_after_withdraw",
                    exc.superseded_by == 2,
                    f"superseded_by={exc.superseded_by}",
                )
            )
        stale = core.export_report(reopened, "run-probe-001", revision=1, audience="public", fmt="json")
        checks.append(
            _check(
                "old_export_rejected_after_withdraw",
                not stale["ok"] and stale["errors"][0]["code"] == "revision_superseded",
                json.dumps(stale.get("errors"), ensure_ascii=False),
            )
        )
        current = reopened.read_current("run-probe-001")
    finally:
        reopened.close()

    internal = core.build_internal_view(current)
    public = core.build_public_view(current)
    internal_text = core.render_json(internal) + core.render_markdown(internal)
    public_text = core.render_json(public) + core.render_markdown(public)

    checks.append(
        _check(
            "withdrawn_audit_record_preserved",
            any(
                e["evidence_id"] == "ev-release"
                and e.get("withdrawn")
                and "excerpt" not in e
                for e in current["evidence"]
            )
            and any(
                s["source_id"] == "s-news" and s.get("withdrawn") and s.get("body") is None
                for s in current["sources"]
            ),
            "withdrawn source/evidence keep inert audit records without usable body/excerpt",
        )
    )
    checks.append(
        _check(
            "withdrawn_excerpt_absent_internal",
            not any(text in internal_text for text in withdrawn_excerpts),
            "internal view must not emit withdrawn excerpts",
        )
    )
    checks.append(
        _check(
            "withdrawn_excerpt_absent_public",
            not any(text in public_text for text in withdrawn_excerpts),
            "public view must not emit withdrawn excerpts",
        )
    )
    checks.append(
        _check(
            "withdrawn_conclusions_absent_public",
            "claim-release" not in public_text and "claim-cross" not in public_text,
            "dependent conclusions excluded from public export",
        )
    )
    checks.append(
        _check(
            "withdrawn_source_absent_public",
            "s-news" not in {s["source_id"] for s in public["sources"]},
            "withdrawn public source metadata omitted",
        )
    )
    checks.append(
        _check(
            "unaffected_public_branch_preserved",
            "claim-author" in public_text and "https://example.org/s-profile-a" in public_text,
            "unaffected branch preserved after withdrawal",
        )
    )
    checks.append(
        _check(
            "internal_marks_withdrawn_without_content",
            "已撤销" in internal_text and not any(text in internal_text for text in withdrawn_excerpts),
            "internal renderer marks withdrawal instead of printing content",
        )
    )
    return {
        "case_id": "source-withdrawal-transition",
        "title": "合法来源撤回：移除可用正文/摘录、级联失效、取代旧导出、保留旁支",
        "trace": [
            {"step": "before", "revision": 1, "s-news": "body retained"},
            {"step": "op", "action": "apply_source_withdrawal(s-news)"},
            {"step": "after", "revision": current["revision"], "s-news": "withdrawn, body=None"},
            {"step": "reopen", "action": "export revision 1", "result": "revision_superseded"},
        ],
        "observed_facts": [
            "撤回本地可用正文会失效依赖链接并级联到断言、事件、假设与覆盖",
            "旧修订在新修订写入后被取代，重连后仍拒绝旧导出",
            "不可读正文与摘录不再出现在内部或公共视图",
            "无关的公共分支完整保留",
            "这是逻辑撤回，不是物理安全删除",
        ],
        "checks": checks,
    }


def case_live_inaccessible_retains_snapshot(workspace):
    snapshot = copy.deepcopy(fixtures.base_snapshot())
    for source in snapshot["sources"]:
        if source["source_id"] == "s-news":
            source["fetch_status"] = "inaccessible"  # live page now unreachable
    # Body is retained: a saved historical snapshot stays usable.
    checks = []
    try:
        core.validate_snapshot(snapshot)
        checks.append(_check("live_inaccessible_gate_accepts", True, "saved body remains usable"))
    except core.GateError as exc:
        checks.append(_check("live_inaccessible_gate_accepts", False, exc.code))
    internal = core.build_internal_view(snapshot)
    public = core.build_public_view(snapshot)
    checks.append(
        _check(
            "live_inaccessible_keeps_claim",
            "claim-release" in {c["claim_id"] for c in internal["claims"]}
            and "claim-release" in {c["claim_id"] for c in public["claims"]},
            "retained body still supports the dependent claim",
        )
    )

    # Dropping the body without the explicit withdrawal transition is malformed,
    # not a legal withdrawal: the gate rejects it rather than silently inverting.
    failed = copy.deepcopy(fixtures.base_snapshot())
    for source in failed["sources"]:
        if source["source_id"] == "s-news":
            source["fetch_status"] = "inaccessible"
            source["body"] = None
    checks.append(_expect_gate_error("missing_body_without_withdrawal_rejected", failed, "source_inaccessible"))
    return {
        "case_id": "live-inaccessible-retains-snapshot",
        "title": "实时不可读不使已保存快照失效；未撤回而丢失正文则被拒绝",
        "trace": [
            {"step": "gate", "action": "s-news fetch_status=inaccessible, body retained", "result": "accepted"},
            {"step": "gate", "action": "s-news body=None without withdrawal", "result": "source_inaccessible"},
        ],
        "observed_facts": [
            "live fetch_status 只是描述，不决定历史快照可用性",
            "只有显式撤回才移除可用正文并级联失效",
            "丢失正文但不声明撤回的输入被视为畸形而拒绝",
        ],
        "checks": checks,
    }


def case_withdrawal_inert_validation(workspace):
    checks = []

    # A) withdrawn source with an active (non-inert) evidence entry.
    active_on_withdrawn = copy.deepcopy(fixtures.base_snapshot())
    for source in active_on_withdrawn["sources"]:
        if source["source_id"] == "s-news":
            source["withdrawn"] = True
            source["body"] = None
    checks.append(
        _expect_gate_error(
            "active_evidence_on_withdrawn_source_rejected",
            active_on_withdrawn,
            "withdrawn_source_active_evidence",
        )
    )

    # B) evidence marked withdrawn on a source that is not withdrawn.
    inert_without_source = copy.deepcopy(fixtures.base_snapshot())
    for item in inert_without_source["evidence"]:
        if item["evidence_id"] == "ev-release":
            item["withdrawn"] = True
            item.pop("excerpt", None)
    checks.append(
        _expect_gate_error(
            "inert_evidence_without_withdrawn_source_rejected",
            inert_without_source,
            "withdrawn_evidence_without_withdrawn_source",
        )
    )

    # C) withdrawn evidence that keeps a usable excerpt.
    inert_with_excerpt = copy.deepcopy(fixtures.base_snapshot())
    for source in inert_with_excerpt["sources"]:
        if source["source_id"] == "s-news":
            source["withdrawn"] = True
            source["body"] = None
    for item in inert_with_excerpt["evidence"]:
        if item["source_id"] == "s-news":
            item["withdrawn"] = True  # excerpt intentionally left in place
    checks.append(
        _expect_gate_error(
            "withdrawn_evidence_with_excerpt_rejected",
            inert_with_excerpt,
            "withdrawn_evidence_has_excerpt",
        )
    )

    # D) an active claim must not lean on inert evidence; the author cannot mark
    # evidence inert to bypass validation without invalidating the claim.
    claim_bypass = copy.deepcopy(fixtures.base_snapshot())
    for source in claim_bypass["sources"]:
        if source["source_id"] == "s-news":
            source["withdrawn"] = True
            source["body"] = None
    for item in claim_bypass["evidence"]:
        if item["source_id"] == "s-news":
            item["withdrawn"] = True
            item.pop("excerpt", None)
    checks.append(
        _expect_gate_error(
            "active_claim_on_inert_evidence_rejected",
            claim_bypass,
            "claim_references_withdrawn_evidence",
        )
    )
    return {
        "case_id": "withdrawal-inert-validation",
        "title": "惰性证据必须绑定撤回来源且不能带摘录或被活动结论引用",
        "trace": [{"step": "gate", "action": "inject inconsistent withdrawal variants", "result": "rejected"}],
        "observed_facts": [
            "撤回来源不能保留活动证据",
            "惰性证据必须属于已撤回来源、不得保留摘录",
            "活动断言不能引用惰性证据，不能靠标记绕过验证",
        ],
        "checks": checks,
    }


# ---------------------------------------------------------------------------
# Case 17: private-only revocation must not leak the private coverage text
# ---------------------------------------------------------------------------


def case_private_coverage_regression(workspace):
    snapshot = fixtures.base_snapshot()
    revoked = core.apply_identity_revocation(snapshot, "person-wang", "s-private-person")
    public = core.build_public_view(revoked)
    public_text = core.render_json(public) + core.render_markdown(public)
    public_claim_ids = {c["claim_id"] for c in public["claims"]}
    public_person_ids = {p["person_id"] for p in public["people_index"]}
    public_questions = {entry.get("question") for entry in public["coverage"]}
    checks = [
        _check(
            "private_coverage_question_absent",
            "王五的私有项目是什么？" not in public_text
            and "王五的私有项目是什么？" not in public_questions,
            "private-only coverage question must not survive its claim invalidation",
        ),
        _check("private_person_absent", "person-wang" not in public_person_ids, str(public_person_ids)),
        _check("private_claim_absent", "claim-wang" not in public_claim_ids, str(public_claim_ids)),
        _check(
            "unaffected_branch_preserved",
            "claim-author" in public_claim_ids and "claim-release" in public_claim_ids,
            str(public_claim_ids),
        ),
    ]
    return {
        "case_id": "private-coverage-invalidation",
        "title": "仅私有身份被撤销后，其覆盖问题文本不随 claim_ids 清空而泄漏",
        "trace": [
            {"step": "before", "coverage": ["王五的私有项目是什么？"]},
            {"step": "op", "action": "apply_identity_revocation(person-wang, s-private-person)"},
            {"step": "after", "public_questions": sorted(q for q in public_questions if q)},
        ],
        "observed_facts": [
            "失效覆盖保留来源依赖，因此受限问题文本被省略",
            "仅私有身份的人物、断言与覆盖不进入公共导出",
            "无关公共分支保留",
        ],
        "checks": checks,
    }


CASES = (
    case_valid_unaffected_branch,
    case_same_name_unlinked,
    case_ineligible_link_states,
    case_inaccessible_source,
    case_forged_excerpt,
    case_broken_reference,
    case_duplicate_and_policy,
    case_leaf_revocation_cascade,
    case_cross_source_basis_revocation,
    case_mixed_basis_revocation,
    case_identity_cycle,
    case_superseded_revision,
    case_public_private,
    case_public_permission_closure,
    case_provenance_controls,
    case_claim_requirements,
    case_export_enums,
    case_source_withdrawal,
    case_live_inaccessible_retains_snapshot,
    case_withdrawal_inert_validation,
    case_private_coverage_regression,
    case_renderer_parity,
    case_renderer_material_fields,
)


def run_all(workspace):
    results = []
    for case in CASES:
        results.append(case(workspace))
    return results

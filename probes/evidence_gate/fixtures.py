"""Original synthetic fixtures for the evidence-gate probe.

All inputs are explicitly authored annotations, NOT output of an NLP
extractor. Everything is synthetic / discovery / unreviewed. The ``example.org``
hosts are placeholders and are never fetched. License: Apache-2.0-original-
synthetic, same as the repository design fixtures.

Text-bearing fields carry an explicit ``*_provenance`` list of claim IDs (or,
for display names, evidence IDs). Declared provenance is authored input, not
semantic truth: the probe only checks that the referenced nodes are allowed for
the audience, not whether the text truly follows from them.
"""

from __future__ import annotations

import copy

SCHEMA_VERSION = "stripsearch/evidence-gate-probe-v1"


def _evidence(evidence_id, source_id, locator, excerpt):
    return {
        "evidence_id": evidence_id,
        "source_id": source_id,
        "locator": locator,
        "excerpt": excerpt,
    }


def _source(source_id, title, body, policy="public_synthetic", fetch_status="fixture"):
    return {
        "source_id": source_id,
        "canonical_url": f"https://example.org/{source_id}",
        "title": title,
        "origin_group_id": f"origin-{source_id}",
        "published_at": "2026-09-01",
        "retrieved_at": "2026-09-20T00:00:00Z",
        "fetch_status": fetch_status,
        "snapshot_hash": None,
        "export_policy": policy,
        "body": body,
    }


def _claim(claim_id, statement, support, refute=None, kind="attributed_statement", status="supported",
           valid_from=None, valid_to=None):
    return {
        "claim_id": claim_id,
        "person_id": "person-lz",
        "statement": statement,
        "kind": kind,
        "status": status,
        "support_evidence_ids": list(support),
        "refute_evidence_ids": list(refute or []),
        "valid_from": valid_from,
        "valid_to": valid_to,
        "as_of": "2026-09-20",
    }


def base_snapshot():
    """A valid synthetic report with one unrelated public branch, one private
    source, one same-name unlinked source, one cross-source identity basis, a
    mixed public/private claim, and provenance on every public text field."""

    body_profile = "LZ-7 是软件作者林舟的公开主页。公开笔名为 Forest。"
    body_news = "软件作者林舟发布 Lantern 2.0。本文引用主页 https://example.org/people/lz7 。"
    body_cross = "据转载：林舟在会议展示了 Lantern。"
    body_private = "内部档案：林舟合同细节 A-17。"
    body_private_person = "内部人物页：研究员王五，负责机密项目。"
    body_name = "林舟，Blue River 乐团作曲者。"

    return {
        "schema_version": SCHEMA_VERSION,
        "run_id": "run-probe-001",
        "state": "completed",
        "synthetic": True,
        "generated_by": "authored_synthetic_fixture_not_agent_run",
        "revision": 1,
        "supersedes": None,
        "as_of": "2026-09-20",
        "people_index": [
            {
                "person_id": "person-lz",
                "display_name": "林舟（合成）",
                "display_name_provenance": ["ev-profile"],
                "identity_status": "resolved",
                "report_anchor": "person-lz",
                "profile_links": [
                    {
                        "url": "https://example.org/people/lz7",
                        "verification_status": "verified_in_fixture",
                        "evidence_ids": ["ev-profile"],
                    }
                ],
                "identity_evidence_ids": ["ev-profile"],
            },
            {
                "person_id": "person-wang",
                "display_name": "王五（合成私有）",
                "display_name_provenance": ["ev-wang"],
                "identity_status": "resolved",
                "report_anchor": "person-wang",
                "profile_links": [
                    {
                        "url": "https://example.org/private/wang",
                        "verification_status": "verified_in_fixture",
                        "evidence_ids": ["ev-wang"],
                    }
                ],
                "identity_evidence_ids": ["ev-wang"],
            },
        ],
        "identity_links": [
            {
                "source_id": "s-profile-a",
                "person_id": "person-lz",
                "state": "linked",
                "basis_evidence_ids": ["ev-profile"],
                "revision": 1,
            },
            {
                "source_id": "s-news",
                "person_id": "person-lz",
                "state": "linked",
                "basis_evidence_ids": ["ev-news-ref"],
                "revision": 1,
            },
            {
                "source_id": "s-cross",
                "person_id": "person-lz",
                "state": "linked",
                "basis_evidence_ids": ["ev-news-ref"],
                "revision": 1,
            },
            {
                "source_id": "s-mixed-private",
                "person_id": "person-lz",
                "state": "linked",
                "basis_evidence_ids": ["ev-private"],
                "revision": 1,
            },
            {
                "source_id": "s-private-person",
                "person_id": "person-wang",
                "state": "linked",
                "basis_evidence_ids": ["ev-wang"],
                "revision": 1,
            },
        ],
        "sources": [
            _source("s-profile-a", "LZ-7 主页（合成）", body_profile),
            _source("s-news", "Lantern 发布稿（合成）", body_news),
            _source("s-cross", "会议转载（合成）", body_cross),
            _source("s-mixed-private", "内部合同档案（合成）", body_private, policy="private_local"),
            _source(
                "s-private-person",
                "内部人物页（合成）",
                body_private_person,
                policy="private_local",
            ),
            _source("s-name-only", "同名乐团主页（合成）", body_name),
            _source("s-blocked", "不可读访谈（合成）", None, policy="restricted", fetch_status="inaccessible"),
            _source("s-forged", "普通页面（合成）", "该页面只有普通陈述。"),
            _source("s-cycle-x", "X 主页（合成）", "X 页面正文。X 自述归属锚点。"),
            _source("s-cycle-y", "Y 主页（合成）", "Y 页面正文。"),
            _source("s-hop", "Hop 页面（合成）", "Hop 页面正文。"),
            _source("s-counter", "反证页面（合成）", "反证：另有来源称发布由团队完成。"),
        ],
        "evidence": [
            _evidence("ev-profile", "s-profile-a", "body:sentence:1", "LZ-7 是软件作者林舟的公开主页。"),
            _evidence("ev-release", "s-news", "body:sentence:1", "软件作者林舟发布 Lantern 2.0。"),
            _evidence(
                "ev-news-ref",
                "s-news",
                "body:sentence:2",
                "本文引用主页 https://example.org/people/lz7 。",
            ),
            _evidence("ev-cross", "s-cross", "body:sentence:1", "林舟在会议展示了 Lantern。"),
            _evidence("ev-private", "s-mixed-private", "body:sentence:1", "内部档案：林舟合同细节 A-17。"),
            _evidence(
                "ev-wang",
                "s-private-person",
                "body:sentence:1",
                "内部人物页：研究员王五，负责机密项目。",
            ),
            _evidence("ev-name", "s-name-only", "body:sentence:1", "林舟，Blue River 乐团作曲者。"),
            _evidence("ev-hop", "s-hop", "body:sentence:1", "Hop 页面正文。"),
            _evidence(
                "ev-counter",
                "s-counter",
                "body:sentence:1",
                "反证：另有来源称发布由团队完成。",
            ),
        ],
        "claims": [
            _claim("claim-author", "公开主页把林舟列为软件作者。", ["ev-profile"]),
            _claim(
                "claim-release",
                "发布稿记录林舟发布 Lantern 2.0。",
                ["ev-release"],
                valid_from="2026-09-01",
            ),
            _claim("claim-cross", "转载称林舟在会议展示了 Lantern。", ["ev-cross"]),
            _claim(
                "claim-mixed",
                "公开稿与内部档案同时支持的工作关系断言。",
                ["ev-release", "ev-private"],
                kind="inference",
            ),
            {
                **_claim("claim-wang", "内部人物页称王五负责机密项目。", ["ev-wang"]),
                "person_id": "person-wang",
            },
        ],
        "events": [
            {
                "event_id": "event-author",
                "person_id": "person-lz",
                "occurred_at": None,
                "recorded_at": "2026-09-01",
                "action_claim_ids": ["claim-author"],
                "outcome_claim_ids": [],
                "context": "公开主页陈述。",
                "context_provenance": ["claim-author"],
                "unknowns": [{"text": "作者长期活动的完整时间线未知。", "provenance": ["claim-author"]}],
            },
            {
                "event_id": "event-release",
                "person_id": "person-lz",
                "occurred_at": None,
                "recorded_at": "2026-09-01",
                "action_claim_ids": ["claim-release"],
                "outcome_claim_ids": [],
                "context": "发布稿陈述。",
                "context_provenance": ["claim-release"],
                "unknowns": [],
            },
            {
                "event_id": "event-cross",
                "person_id": "person-lz",
                "occurred_at": None,
                "recorded_at": "2026-09-01",
                "action_claim_ids": ["claim-cross"],
                "outcome_claim_ids": [],
                "context": "转载陈述。",
                "context_provenance": ["claim-cross"],
                "unknowns": [],
            },
        ],
        "behavior_hypotheses": [
            {
                "hypothesis_id": "hyp-author",
                "person_id": "person-lz",
                "statement": "假设：林舟以软件作者身份公开活动。",
                "statement_provenance": ["claim-author"],
                "support_event_ids": ["event-author"],
                "counter_event_ids": [],
                "alternatives": [],
                "alternatives_provenance": [],
                "falsifier": "主页被证明属于他人。",
                "falsifier_provenance": ["claim-author"],
                "status": "hypothesis",
            },
            {
                "hypothesis_id": "hyp-release",
                "person_id": "person-lz",
                "statement": "假设：Lantern 2.0 由林舟主导发布。",
                "statement_provenance": ["claim-release"],
                "support_event_ids": ["event-release"],
                "counter_event_ids": [],
                "alternatives": [],
                "alternatives_provenance": [],
                "falsifier": "发布稿作者另有其人。",
                "falsifier_provenance": ["claim-release"],
                "status": "hypothesis",
            },
            {
                "hypothesis_id": "hyp-cross",
                "person_id": "person-lz",
                "statement": "假设：转载内容源自一次真实会议展示。",
                "statement_provenance": ["claim-cross"],
                "support_event_ids": ["event-cross"],
                "counter_event_ids": [],
                "alternatives": [],
                "alternatives_provenance": [],
                "falsifier": "转载无原始来源。",
                "falsifier_provenance": ["claim-cross"],
                "status": "hypothesis",
            },
        ],
        "coverage": [
            {
                "question": "公开主页是否把林舟列为作者？",
                "status": "answered",
                "claim_ids": ["claim-author"],
                "provenance": ["claim-author"],
            },
            {
                "question": "发布稿记录了什么？",
                "status": "answered",
                "claim_ids": ["claim-release"],
                "provenance": ["claim-release"],
            },
            {
                "question": "转载说明了什么？",
                "status": "answered",
                "claim_ids": ["claim-cross"],
                "provenance": ["claim-cross"],
            },
            {
                "question": "王五的私有项目是什么？",
                "status": "answered",
                "claim_ids": ["claim-wang"],
                "provenance": ["claim-wang"],
            },
            {
                "question": "能否判断长期维护能力？",
                "status": "unknown",
                "reason": "无后续记录。",
                "provenance": ["claim-release"],
                "reason_provenance": ["claim-release"],
            },
        ],
        "unknowns": [
            {
                "unknown_id": "u-release",
                "text": "发布后的长期维护情况未确认。",
                "provenance": ["claim-release"],
            },
            {
                "unknown_id": "u-private",
                "text": "私有合同档案限制下的细节未知。",
                "provenance": ["claim-mixed"],
            },
        ],
        "usage": {
            "measurement_status": "not_run",
            "requests": None,
            "cost_usd": None,
            "elapsed_seconds": None,
        },
        "stop_reason": "synthetic_scope_complete",
    }


def mixed_basis_snapshot():
    """s-cross gets a self-source excerpt *and* its cross-source dependency.

    The self excerpt must not waive the required cross dependency: revoking
    s-news must still drop s-cross.
    """

    snapshot = copy.deepcopy(base_snapshot())
    for link in snapshot["identity_links"]:
        if link["source_id"] == "s-cross":
            link["basis_evidence_ids"] = ["ev-news-ref", "ev-cross"]
    return snapshot


def permission_chain_snapshot():
    """Three-hop public identity chain s-hop -> s-cross -> s-news."""

    snapshot = copy.deepcopy(base_snapshot())
    snapshot["identity_links"].append(
        {
            "source_id": "s-hop",
            "person_id": "person-lz",
            "state": "linked",
            "basis_evidence_ids": ["ev-cross"],
            "revision": 1,
        }
    )
    snapshot["claims"].append(_claim("claim-hop", "Hop 页面支持的一条断言。", ["ev-hop"]))
    return snapshot


def counterevidence_snapshot():
    """A contested claim with distinct support/refute markers, an event with an
    outcome claim and an unknown, and a hypothesis with counter events,
    alternatives and a falsifier."""

    snapshot = copy.deepcopy(base_snapshot())
    snapshot["identity_links"].append(
        {
            "source_id": "s-counter",
            "person_id": "person-lz",
            "state": "linked",
            "basis_evidence_ids": ["ev-counter"],
            "revision": 1,
        }
    )
    snapshot["claims"].append(
        _claim(
            "claim-contested",
            "发布归属存在冲突证据。",
            ["ev-release"],
            refute=["ev-counter"],
            kind="factual",
            status="conflicting",
            valid_from="2026-01-01",
            valid_to="2026-12-31",
        )
    )
    snapshot["events"].append(
        {
            "event_id": "event-contested",
            "person_id": "person-lz",
            "occurred_at": "2026-09-05",
            "recorded_at": "2026-09-06",
            "action_claim_ids": ["claim-contested"],
            "outcome_claim_ids": ["claim-release"],
            "context": "冲突证据事件。",
            "context_provenance": ["claim-contested"],
            "unknowns": [{"text": "冲突的最终裁决未知。", "provenance": ["claim-contested"]}],
        }
    )
    snapshot["behavior_hypotheses"].append(
        {
            "hypothesis_id": "hyp-contested",
            "person_id": "person-lz",
            "statement": "假设：发布由团队共同完成。",
            "statement_provenance": ["claim-contested"],
            "support_event_ids": ["event-author"],
            "counter_event_ids": ["event-contested"],
            "alternatives": ["替代解释：个人主导。", "替代解释：机构主导。"],
            "alternatives_provenance": [["claim-author"], ["claim-release"]],
            "falsifier": "出现签署的个人发布指令。",
            "falsifier_provenance": ["claim-contested"],
            "status": "hypothesis",
        }
    )
    return snapshot


def provenance_snapshot():
    """Negative and mixed public-provenance controls.

    Nodes below carry missing or restricted provenance for their text and must
    be omitted from public export while remaining in the internal view.
    """

    snapshot = copy.deepcopy(base_snapshot())
    snapshot["events"].append(
        {
            "event_id": "event-noprov",
            "person_id": "person-lz",
            "occurred_at": None,
            "recorded_at": "2026-09-01",
            "action_claim_ids": ["claim-author"],
            "outcome_claim_ids": [],
            "context": "无来源标注的上下文。",
            "unknowns": [{"text": "无来源标注的事件未知。"}],
        }
    )
    snapshot["events"].append(
        {
            "event_id": "event-mixed",
            "person_id": "person-lz",
            "occurred_at": None,
            "recorded_at": "2026-09-01",
            "action_claim_ids": ["claim-author"],
            "outcome_claim_ids": [],
            "context": "混合来源上下文。",
            "context_provenance": ["claim-author", "claim-wang"],
            "unknowns": [],
        }
    )
    snapshot["behavior_hypotheses"].append(
        {
            "hypothesis_id": "hyp-noprov",
            "person_id": "person-lz",
            "statement": "无来源标注的假设。",
            "support_event_ids": ["event-author"],
            "counter_event_ids": [],
            "alternatives": [],
            "alternatives_provenance": [],
            "falsifier": "无来源标注的否定条件。",
            "status": "hypothesis",
        }
    )
    snapshot["behavior_hypotheses"].append(
        {
            "hypothesis_id": "hyp-partial",
            "person_id": "person-lz",
            "statement": "部分来源标注的假设。",
            "statement_provenance": ["claim-author"],
            "support_event_ids": ["event-author"],
            "counter_event_ids": [],
            "alternatives": ["有来源的替代解释。", "缺来源的替代解释。"],
            "alternatives_provenance": [["claim-author"], ["claim-wang"]],
            "falsifier": "缺来源的否定条件。",
            "status": "hypothesis",
        }
    )
    snapshot["coverage"].append(
        {"question": "无来源标注的问题？", "status": "unknown", "reason": "无来源标注的原因。"}
    )
    snapshot["unknowns"].append({"unknown_id": "u-noprov", "text": "无来源标注的未知。"})
    return snapshot


def cycle_snapshot():
    """Two sources whose only identity basis is each other (unsupported cycle)."""

    return _two_link_snapshot(x_bases=["ev-y"], y_bases=["ev-x"])


def mixed_basis_cycle_snapshot():
    """A self-source excerpt plus a required circular cross dependency.

    The self excerpt must not erase the cross prerequisite, so the cycle is
    unsupported and rejected.
    """

    return _two_link_snapshot(x_bases=["ev-y", "ev-x-anchor"], y_bases=["ev-x"])


def anchored_chain_snapshot():
    """X is a true independent anchor (pure self-source basis) and resolves Y."""

    return _two_link_snapshot(x_bases=["ev-x-anchor"], y_bases=["ev-x"])


def _two_link_snapshot(x_bases, y_bases):
    return {
        "schema_version": SCHEMA_VERSION,
        "run_id": "run-probe-cycle",
        "state": "completed",
        "synthetic": True,
        "generated_by": "authored_synthetic_fixture_not_agent_run",
        "revision": 1,
        "supersedes": None,
        "as_of": "2026-09-20",
        "people_index": [
            {
                "person_id": "person-lz",
                "display_name": "林舟（合成）",
                "display_name_provenance": [],
                "identity_status": "resolved",
                "report_anchor": "person-lz",
                "profile_links": [],
                "identity_evidence_ids": [],
            }
        ],
        "identity_links": [
            {
                "source_id": "s-cycle-x",
                "person_id": "person-lz",
                "state": "linked",
                "basis_evidence_ids": list(x_bases),
                "revision": 1,
            },
            {
                "source_id": "s-cycle-y",
                "person_id": "person-lz",
                "state": "linked",
                "basis_evidence_ids": list(y_bases),
                "revision": 1,
            },
        ],
        "sources": [
            _source("s-cycle-x", "X 主页（合成）", "X 页面正文。X 自述归属锚点。"),
            _source("s-cycle-y", "Y 主页（合成）", "Y 页面正文。"),
        ],
        "evidence": [
            _evidence("ev-x", "s-cycle-x", "body:sentence:1", "X 页面正文。"),
            _evidence("ev-x-anchor", "s-cycle-x", "body:sentence:2", "X 自述归属锚点。"),
            _evidence("ev-y", "s-cycle-y", "body:sentence:1", "Y 页面正文。"),
        ],
        "claims": [_claim("claim-cycle", "X 页面正文记录了一条合成断言。", ["ev-x"])],
        "events": [],
        "behavior_hypotheses": [],
        "coverage": [],
        "unknowns": [],
        "usage": {
            "measurement_status": "not_run",
            "requests": None,
            "cost_usd": None,
            "elapsed_seconds": None,
        },
        "stop_reason": "synthetic_scope_complete",
    }


def hostile_snapshot():
    """Public snapshot with hostile display/title/url strings for escaping."""

    snapshot = copy.deepcopy(base_snapshot())
    snapshot["run_id"] = "run-probe-hostile"
    snapshot["people_index"][0]["display_name"] = "林舟 <script>alert(1)</script>"
    for source in snapshot["sources"]:
        if source["source_id"] == "s-profile-a":
            source["title"] = "<img src=x onerror=alert(1)>"
        if source["source_id"] == "s-news":
            source["canonical_url"] = "javascript:alert(1)"
        if source["source_id"] == "s-cross":
            source["canonical_url"] = "https://example.org/a(b)c"
    return snapshot

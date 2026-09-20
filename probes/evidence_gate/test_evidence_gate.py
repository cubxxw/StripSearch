"""Meaningful unittest suite for the offline evidence-gate probe.

Every test asserts observed behavior of the importable core, not a replayed
expected output. No network, model or provider calls. Run with:
    python3 -m unittest discover -s probes/evidence_gate -p 'test_*.py' -v
"""

from __future__ import annotations

import copy
import io
import json
import os
import socket
import sqlite3
import tempfile
import unittest
import urllib.request
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

import cases
import core
import fixtures
import run


class NetworkGuardTests(unittest.TestCase):
    def test_guard_blocks_and_records_forbidden_calls(self):
        with core.NetworkGuard() as guard:
            with self.assertRaises(core.ForbiddenCall):
                socket.create_connection(("example.org", 80))
            with self.assertRaises(core.ForbiddenCall):
                socket.getaddrinfo("example.org", 80)
            with self.assertRaises(core.ForbiddenCall):
                urllib.request.urlopen("https://example.org/")
        self.assertIn("socket.create_connection", guard.attempts)
        self.assertIn("socket.getaddrinfo", guard.attempts)
        self.assertIn("urllib.request.urlopen", guard.attempts)

    def test_guard_restores_stdlib_after_exit(self):
        original = socket.create_connection
        with core.NetworkGuard():
            pass
        self.assertIs(socket.create_connection, original)


class GateTests(unittest.TestCase):
    def test_valid_snapshot_passes_and_seeds_are_eligible(self):
        snapshot = fixtures.base_snapshot()
        core.validate_snapshot(snapshot)
        eligibility = core.link_eligibility(snapshot)
        self.assertTrue(eligibility[("person-lz", "s-profile-a")][0])
        self.assertTrue(eligibility[("person-lz", "s-news")][0])
        self.assertTrue(eligibility[("person-lz", "s-cross")][0])

    def test_same_name_source_is_not_auto_linked(self):
        snapshot = copy.deepcopy(fixtures.base_snapshot())
        snapshot["claims"].append(
            {
                "claim_id": "claim-name",
                "person_id": "person-lz",
                "statement": "同名来源断言。",
                "kind": "attributed_statement",
                "status": "supported",
                "support_evidence_ids": ["ev-name"],
                "refute_evidence_ids": [],
                "valid_from": None,
                "valid_to": None,
                "as_of": "2026-09-20",
            }
        )
        with self.assertRaises(core.GateError) as ctx:
            core.validate_snapshot(snapshot)
        self.assertEqual(ctx.exception.code, "claim_source_unlinked")
        self.assertFalse(core.link_eligibility(snapshot).get(("person-lz", "s-name-only"), (False,))[0])

    def test_ineligible_link_states_and_cross_regression(self):
        for state in ("rejected", "candidate", "disputed"):
            snapshot = copy.deepcopy(fixtures.base_snapshot())
            for link in snapshot["identity_links"]:
                if link["person_id"] == "person-lz" and link["source_id"] == "s-news":
                    link["state"] = state
            with self.assertRaises(core.GateError) as ctx:
                core.validate_snapshot(snapshot)
            self.assertEqual(ctx.exception.code, "claim_source_unlinked")
            self.assertFalse(core.link_eligibility(snapshot)[("person-lz", "s-news")][0])

        # Item 1 regression: a rejected cross-source link must not re-enter the
        # fixpoint through its eligible dependency.
        cross = copy.deepcopy(fixtures.base_snapshot())
        for link in cross["identity_links"]:
            if link["source_id"] == "s-cross":
                link["state"] = "rejected"
        eligibility = core.link_eligibility(cross)[("person-lz", "s-cross")]
        self.assertFalse(eligibility[0])
        with self.assertRaises(core.GateError) as ctx:
            core.validate_snapshot(cross)
        self.assertEqual(ctx.exception.code, "claim_source_unlinked")

    def test_inaccessible_and_forged_are_rejected(self):
        inaccessible = copy.deepcopy(fixtures.base_snapshot())
        inaccessible["evidence"].append(
            {"evidence_id": "ev-blocked", "source_id": "s-blocked", "locator": "b", "excerpt": "x"}
        )
        with self.assertRaises(core.GateError) as ctx:
            core.validate_snapshot(inaccessible)
        self.assertEqual(ctx.exception.code, "source_inaccessible")

        forged = copy.deepcopy(fixtures.base_snapshot())
        forged["evidence"].append(
            {"evidence_id": "ev-forged", "source_id": "s-forged", "locator": "b", "excerpt": "不存在"}
        )
        with self.assertRaises(core.GateError) as ctx:
            core.validate_snapshot(forged)
        self.assertEqual(ctx.exception.code, "excerpt_not_found")

    def test_duplicate_unknown_policy_and_broken_refs(self):
        duplicate = copy.deepcopy(fixtures.base_snapshot())
        duplicate["claims"].append(copy.deepcopy(duplicate["claims"][0]))
        with self.assertRaises(core.GateError) as ctx:
            core.validate_snapshot(duplicate)
        self.assertEqual(ctx.exception.code, "duplicate_id")

        policy = copy.deepcopy(fixtures.base_snapshot())
        policy["sources"][0]["export_policy"] = "mystery"
        with self.assertRaises(core.GateError) as ctx:
            core.validate_snapshot(policy)
        self.assertEqual(ctx.exception.code, "unknown_export_policy")

        broken = copy.deepcopy(fixtures.base_snapshot())
        broken["claims"][0]["support_evidence_ids"] = ["ev-missing"]
        with self.assertRaises(core.GateError) as ctx:
            core.validate_snapshot(broken)
        self.assertEqual(ctx.exception.code, "unknown_reference")

    def test_cycles_and_anchored_chain(self):
        with self.assertRaises(core.GateError) as ctx:
            core.validate_snapshot(fixtures.cycle_snapshot())
        self.assertEqual(ctx.exception.code, "identity_cycle")
        with self.assertRaises(core.GateError) as ctx:
            core.validate_snapshot(fixtures.mixed_basis_cycle_snapshot())
        self.assertEqual(ctx.exception.code, "identity_cycle")
        core.validate_snapshot(fixtures.anchored_chain_snapshot())
        eligibility = core.link_eligibility(fixtures.anchored_chain_snapshot())
        self.assertTrue(eligibility[("person-lz", "s-cycle-x")][0])
        self.assertTrue(eligibility[("person-lz", "s-cycle-y")][0])

    def test_claim_status_requirements_and_enums(self):
        no_support = copy.deepcopy(fixtures.base_snapshot())
        no_support["claims"].append(
            {
                "claim_id": "claim-nosupport",
                "person_id": "person-lz",
                "statement": "无支持证据。",
                "kind": "factual",
                "status": "supported",
                "support_evidence_ids": [],
                "refute_evidence_ids": [],
                "valid_from": None,
                "valid_to": None,
                "as_of": "2026-09-20",
            }
        )
        with self.assertRaises(core.GateError) as ctx:
            core.validate_snapshot(no_support)
        self.assertEqual(ctx.exception.code, "claim_missing_support")

        insufficient = copy.deepcopy(fixtures.base_snapshot())
        insufficient["claims"].append(
            {
                "claim_id": "claim-insufficient",
                "person_id": "person-lz",
                "statement": "证据不足。",
                "kind": "inference",
                "status": "insufficient_evidence",
                "support_evidence_ids": [],
                "refute_evidence_ids": [],
                "valid_from": None,
                "valid_to": None,
                "as_of": "2026-09-20",
            }
        )
        core.validate_snapshot(insufficient)

        for mutate, code in (
            (lambda s: s["claims"][0].__setitem__("kind", "vibe"), "invalid_claim_kind"),
            (lambda s: s["claims"][0].__setitem__("status", "probably"), "invalid_claim_status"),
            (lambda s: s.__setitem__("revision", 0), "invalid_revision"),
            (lambda s: s["identity_links"][0].__setitem__("state", "maybe"), "invalid_link_state"),
            (lambda s: s["coverage"][0].__setitem__("status", "almost"), "invalid_coverage_status"),
        ):
            snapshot = copy.deepcopy(fixtures.base_snapshot())
            mutate(snapshot)
            with self.assertRaises(core.GateError) as ctx:
                core.validate_snapshot(snapshot)
            self.assertEqual(ctx.exception.code, code)


class RevocationTests(unittest.TestCase):
    def test_leaf_revocation_cascades_and_preserves_branch(self):
        snapshot = fixtures.base_snapshot()
        revoked = core.apply_identity_revocation(snapshot, "person-lz", "s-news")
        internal = core.build_internal_view(revoked)
        ids = {c["claim_id"] for c in internal["claims"]}
        events = {e["event_id"] for e in internal["events"]}
        hypotheses = {h["hypothesis_id"] for h in internal["behavior_hypotheses"]}
        coverage = {entry["question"]: entry for entry in internal["coverage"]}
        self.assertNotIn("claim-release", ids)
        self.assertNotIn("event-release", events)
        self.assertNotIn("hyp-release", hypotheses)
        self.assertEqual(coverage["发布稿记录了什么？"]["status"], "blocked")
        self.assertIn("claim-author", ids)
        self.assertIn("event-author", events)
        core.validate_snapshot(revoked)

    def test_cross_source_basis_revocation_propagates(self):
        snapshot = fixtures.base_snapshot()
        self.assertTrue(core.link_eligibility(snapshot)[("person-lz", "s-cross")][0])
        revoked = core.apply_identity_revocation(snapshot, "person-lz", "s-news")
        self.assertFalse(core.link_eligibility(revoked)[("person-lz", "s-cross")][0])
        internal = core.build_internal_view(revoked)
        self.assertNotIn("claim-cross", {c["claim_id"] for c in internal["claims"]})
        self.assertIn("claim-author", {c["claim_id"] for c in internal["claims"]})

    def test_mixed_basis_does_not_waive_cross_dependency(self):
        snapshot = fixtures.mixed_basis_snapshot()
        self.assertTrue(core.link_eligibility(snapshot)[("person-lz", "s-cross")][0])
        revoked = core.apply_identity_revocation(snapshot, "person-lz", "s-news")
        self.assertFalse(core.link_eligibility(revoked)[("person-lz", "s-cross")][0])
        internal = core.build_internal_view(revoked)
        ids = {c["claim_id"] for c in internal["claims"]}
        self.assertNotIn("claim-cross", ids)
        self.assertIn("claim-author", ids)


class PermissionClosureTests(unittest.TestCase):
    def test_public_permission_fixed_point_and_no_dangling(self):
        snapshot = fixtures.permission_chain_snapshot()
        before = {c["claim_id"] for c in core.build_public_view(snapshot)["claims"]}
        self.assertIn("claim-hop", before)
        self.assertIn("claim-cross", before)
        for source in snapshot["sources"]:
            if source["source_id"] == "s-news":
                source["export_policy"] = "private_local"
        public = core.build_public_view(snapshot)
        ids = {c["claim_id"] for c in public["claims"]}
        self.assertNotIn("claim-release", ids)
        self.assertNotIn("claim-cross", ids)
        self.assertNotIn("claim-hop", ids)
        self.assertIn("claim-author", ids)
        evidence_ids = {e["evidence_id"] for e in public["evidence"]}
        source_ids = {s["source_id"] for s in public["sources"]}
        for link in public["identity_links"]:
            for evidence_id in link["basis_evidence_ids"]:
                self.assertIn(evidence_id, evidence_ids)
        for claim in public["claims"]:
            for evidence_id in list(claim["support_evidence_ids"]) + list(claim["refute_evidence_ids"]):
                self.assertIn(evidence_id, evidence_ids)
        for person in public["people_index"]:
            for evidence_id in person["identity_evidence_ids"]:
                self.assertIn(evidence_id, evidence_ids)
        for evidence in public["evidence"]:
            self.assertIn(evidence["source_id"], source_ids)


class WithdrawalTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="evidence-gate-test-")
        self.path = os.path.join(self._tmp.name, "withdraw.sqlite")

    def tearDown(self):
        self._tmp.cleanup()

    def test_source_withdrawal_supersedes_and_preserves_branch(self):
        first = fixtures.base_snapshot()
        withdrawn = core.apply_source_withdrawal(first, "s-news")
        self.assertEqual((withdrawn["revision"], withdrawn["supersedes"]), (2, 1))
        store = core.SnapshotStore(self.path)
        store.add_revision(first)
        store.add_revision(withdrawn)
        store.close()

        reopened = core.SnapshotStore(self.path)
        try:
            with self.assertRaises(core.RevisionSuperseded) as ctx:
                reopened.read_revision("run-probe-001", 1)
            self.assertEqual(ctx.exception.superseded_by, 2)
            stale = core.export_report(reopened, "run-probe-001", revision=1, audience="public")
            self.assertFalse(stale["ok"])
            self.assertEqual(stale["errors"][0]["code"], "revision_superseded")
            current = reopened.read_current("run-probe-001")
        finally:
            reopened.close()

        # Inert audit record preserved without usable body/excerpt.
        self.assertTrue(
            any(
                e["evidence_id"] == "ev-release"
                and e.get("withdrawn")
                and "excerpt" not in e
                for e in current["evidence"]
            )
        )
        self.assertTrue(
            any(
                s["source_id"] == "s-news" and s.get("withdrawn") and s.get("body") is None
                for s in current["sources"]
            )
        )

        internal_text = core.render_json(core.build_internal_view(current)) + core.render_markdown(
            core.build_internal_view(current)
        )
        public_view = core.build_public_view(current)
        public_text = core.render_json(public_view) + core.render_markdown(public_view)
        for excerpt in (
            "软件作者林舟发布 Lantern 2.0。",
            "本文引用主页 https://example.org/people/lz7 。",
        ):
            self.assertNotIn(excerpt, internal_text)
            self.assertNotIn(excerpt, public_text)
        self.assertIn("已撤销", internal_text)
        self.assertNotIn("claim-release", public_text)
        self.assertNotIn("s-news", {s["source_id"] for s in public_view["sources"]})
        self.assertIn("claim-author", {c["claim_id"] for c in public_view["claims"]})
        self.assertIn("https://example.org/s-profile-a", public_text)

    def test_live_inaccessible_retained_snapshot_stays_usable(self):
        live = copy.deepcopy(fixtures.base_snapshot())
        for source in live["sources"]:
            if source["source_id"] == "s-news":
                source["fetch_status"] = "inaccessible"
        core.validate_snapshot(live)
        self.assertIn("claim-release", {c["claim_id"] for c in core.build_public_view(live)["claims"]})

        failed = copy.deepcopy(fixtures.base_snapshot())
        for source in failed["sources"]:
            if source["source_id"] == "s-news":
                source["fetch_status"] = "inaccessible"
                source["body"] = None
        with self.assertRaises(core.GateError) as ctx:
            core.validate_snapshot(failed)
        self.assertEqual(ctx.exception.code, "source_inaccessible")

    def test_inert_evidence_cannot_bypass_validation(self):
        active_on_withdrawn = copy.deepcopy(fixtures.base_snapshot())
        for source in active_on_withdrawn["sources"]:
            if source["source_id"] == "s-news":
                source["withdrawn"] = True
                source["body"] = None
        with self.assertRaises(core.GateError) as ctx:
            core.validate_snapshot(active_on_withdrawn)
        self.assertEqual(ctx.exception.code, "withdrawn_source_active_evidence")

        inert_without_source = copy.deepcopy(fixtures.base_snapshot())
        for item in inert_without_source["evidence"]:
            if item["evidence_id"] == "ev-release":
                item["withdrawn"] = True
                item.pop("excerpt", None)
        with self.assertRaises(core.GateError) as ctx:
            core.validate_snapshot(inert_without_source)
        self.assertEqual(ctx.exception.code, "withdrawn_evidence_without_withdrawn_source")

        inert_with_excerpt = copy.deepcopy(fixtures.base_snapshot())
        for source in inert_with_excerpt["sources"]:
            if source["source_id"] == "s-news":
                source["withdrawn"] = True
                source["body"] = None
        for item in inert_with_excerpt["evidence"]:
            if item["source_id"] == "s-news":
                item["withdrawn"] = True
        with self.assertRaises(core.GateError) as ctx:
            core.validate_snapshot(inert_with_excerpt)
        self.assertEqual(ctx.exception.code, "withdrawn_evidence_has_excerpt")

        claim_bypass = copy.deepcopy(fixtures.base_snapshot())
        for source in claim_bypass["sources"]:
            if source["source_id"] == "s-news":
                source["withdrawn"] = True
                source["body"] = None
        for item in claim_bypass["evidence"]:
            if item["source_id"] == "s-news":
                item["withdrawn"] = True
                item.pop("excerpt", None)
        with self.assertRaises(core.GateError) as ctx:
            core.validate_snapshot(claim_bypass)
        self.assertEqual(ctx.exception.code, "claim_references_withdrawn_evidence")

    def test_private_coverage_not_leaked_after_revocation(self):
        revoked = core.apply_identity_revocation(
            fixtures.base_snapshot(), "person-wang", "s-private-person"
        )
        public = core.build_public_view(revoked)
        public_text = core.render_json(public) + core.render_markdown(public)
        self.assertNotIn("王五的私有项目是什么？", public_text)
        self.assertNotIn("person-wang", {p["person_id"] for p in public["people_index"]})
        self.assertNotIn("claim-wang", {c["claim_id"] for c in public["claims"]})
        self.assertIn("claim-author", {c["claim_id"] for c in public["claims"]})


class PublicExportTests(unittest.TestCase):
    def test_mixed_and_private_only_are_omitted(self):
        snapshot = fixtures.base_snapshot()
        public = core.build_public_view(snapshot)
        ids = {c["claim_id"] for c in public["claims"]}
        self.assertNotIn("claim-mixed", ids)
        self.assertIn("claim-release", ids)
        people = {p["person_id"] for p in public["people_index"]}
        self.assertNotIn("person-wang", people)
        sources = {s["source_id"] for s in public["sources"]}
        self.assertNotIn("s-mixed-private", sources)
        rendered = core.render_json(public) + core.render_markdown(public)
        for leaked in ("内部合同档案", "王五（合成私有）", "https://example.org/private/wang"):
            self.assertNotIn(leaked, rendered)
        unknowns = {u["unknown_id"] for u in public["unknowns"] if isinstance(u, dict)}
        self.assertNotIn("u-private", unknowns)
        self.assertIn("u-release", unknowns)

    def test_public_export_drops_private_paths_source_body_and_metadata(self):
        snapshot = fixtures.base_snapshot()
        for source in snapshot["sources"]:
            if source["source_id"] == "s-profile-a":
                source["internal_uri"] = "/Users/example/private/notes.md"
        public = core.build_public_view(snapshot)
        rendered = core.render_json(public) + core.render_markdown(public)
        self.assertNotIn("/Users/example", rendered)
        self.assertNotIn("internal_uri", rendered)
        self.assertNotIn("公开笔名为 Forest", rendered)
        self.assertIn("LZ-7 是软件作者林舟的公开主页。", rendered)
        # Free-text metadata is internal-only; typed structural metadata remains.
        self.assertNotIn("stop_reason", rendered)
        self.assertNotIn("synthetic_scope_complete", rendered)
        self.assertIn('"synthetic": true', rendered)

    def test_provenance_controls(self):
        snapshot = fixtures.provenance_snapshot()
        public = core.build_public_view(snapshot)
        internal = core.build_internal_view(snapshot)
        public_text = core.render_json(public) + core.render_markdown(public)
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
        for text in negatives:
            self.assertNotIn(text, public_text)
            self.assertIn(text, internal_json)
        self.assertIn("公开主页陈述。", public_text)
        self.assertIn("主页被证明属于他人。", public_text)
        self.assertIn("部分来源标注的假设。", public_text)
        self.assertIn("有来源的替代解释。", public_text)
        self.assertIn("能否判断长期维护能力？", public_text)

        no_name = copy.deepcopy(fixtures.base_snapshot())
        for person in no_name["people_index"]:
            if person["person_id"] == "person-lz":
                person.pop("display_name_provenance", None)
        self.assertNotIn(
            "person-lz", {p["person_id"] for p in core.build_public_view(no_name)["people_index"]}
        )


class RendererTests(unittest.TestCase):
    def test_parity_escaping_and_purity(self):
        snapshot = fixtures.base_snapshot()
        before = copy.deepcopy(snapshot)
        for builder in (core.build_internal_view, core.build_public_view):
            view = builder(snapshot)
            parsed = json.loads(core.render_json(view))
            markdown = core.render_markdown(view)
            for claim in parsed["claims"]:
                self.assertIn(claim["claim_id"], markdown)
                for evidence_id in list(claim["support_evidence_ids"]) + list(claim["refute_evidence_ids"]):
                    self.assertIn(evidence_id, markdown)
            for person in parsed["people_index"]:
                self.assertIn(f'id="{person["report_anchor"]}"', markdown)
            for source in parsed["sources"]:
                self.assertIn(source["canonical_url"], markdown)
            self.assertIn(f"revision {parsed['revision']}", markdown)
            self.assertIn(parsed["as_of"], markdown)
        self.assertEqual(snapshot, before)

        hostile = core.build_public_view(fixtures.hostile_snapshot())
        markdown = core.render_markdown(hostile)
        self.assertIn("&lt;script&gt;", markdown)
        self.assertNotIn("<script>", markdown)
        self.assertNotIn("](javascript:", markdown)
        self.assertIn("a%28b%29c", markdown)

    def test_material_per_node_fields_render(self):
        public = core.build_public_view(fixtures.counterevidence_snapshot())
        parsed = json.loads(core.render_json(public))
        markdown = core.render_markdown(public)
        self.assertIn("support", markdown)
        self.assertIn("refute", markdown)
        self.assertIn("counter=", markdown)
        self.assertIn("alternatives=", markdown)
        self.assertIn("falsifier=", markdown)
        for claim in parsed["claims"]:
            for evidence_id in list(claim["support_evidence_ids"]) + list(claim["refute_evidence_ids"]):
                self.assertIn(evidence_id, markdown)
            for field in ("valid_from", "valid_to"):
                if claim.get(field):
                    self.assertIn(claim[field], markdown)
        for event in parsed["events"]:
            for claim_id in list(event["action_claim_ids"]) + list(event["outcome_claim_ids"]):
                self.assertIn(claim_id, markdown)
            for unknown in event.get("unknowns", []):
                if isinstance(unknown, dict) and unknown.get("text"):
                    self.assertIn(unknown["text"], markdown)
        for hypothesis in parsed["behavior_hypotheses"]:
            for event_id in list(hypothesis["support_event_ids"]) + list(
                hypothesis["counter_event_ids"]
            ):
                self.assertIn(event_id, markdown)
            if hypothesis.get("falsifier"):
                self.assertIn(hypothesis["falsifier"], markdown)
            for alternative in hypothesis.get("alternatives", []):
                self.assertIn(alternative, markdown)


class RevisionStoreTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="evidence-gate-test-")
        self.path = os.path.join(self._tmp.name, "revisions.sqlite")

    def tearDown(self):
        self._tmp.cleanup()

    def test_superseded_read_after_reopen_and_malformed_does_not_supersede(self):
        first = fixtures.base_snapshot()
        store = core.SnapshotStore(self.path)
        store.add_revision(first)
        store.add_revision(core.apply_identity_revocation(first, "person-lz", "s-news"))
        store.close()

        reopened = core.SnapshotStore(self.path)
        try:
            with self.assertRaises(core.RevisionSuperseded) as ctx:
                reopened.read_revision("run-probe-001", 1)
            self.assertEqual(ctx.exception.superseded_by, 2)
            self.assertEqual(reopened.read_current("run-probe-001")["revision"], 2)

            envelope = core.export_report(reopened, "run-probe-001", revision=1, fmt="json")
            self.assertFalse(envelope["ok"])
            self.assertEqual(envelope["errors"][0]["code"], "revision_superseded")

            malformed = copy.deepcopy(first)
            malformed["revision"] = 3
            malformed["sources"].append(copy.deepcopy(malformed["sources"][0]))
            with self.assertRaises(core.GateError):
                reopened.add_revision(malformed)
            self.assertEqual(reopened.read_current("run-probe-001")["revision"], 2)

            with self.assertRaises(sqlite3.DatabaseError):
                with reopened.conn:
                    reopened.conn.execute(
                        "UPDATE revisions SET payload='{}' WHERE run_id=? AND revision=2",
                        ("run-probe-001",),
                    )
        finally:
            reopened.close()

    def test_export_enums_fail_closed(self):
        store = core.SnapshotStore(":memory:")
        try:
            store.add_revision(fixtures.base_snapshot())
            bad_audience = core.export_report(store, "run-probe-001", audience="publci")
            bad_format = core.export_report(store, "run-probe-001", fmt="markdwn")
            public_ok = core.export_report(store, "run-probe-001", audience="public", fmt="json")
            internal_ok = core.export_report(store, "run-probe-001", audience="internal", fmt="markdown")
        finally:
            store.close()
        self.assertFalse(bad_audience["ok"])
        self.assertEqual(bad_audience["errors"][0]["code"], "invalid_audience")
        self.assertFalse(bad_format["ok"])
        self.assertEqual(bad_format["errors"][0]["code"], "invalid_format")
        self.assertTrue(public_ok["ok"])
        self.assertTrue(internal_ok["ok"])
        self.assertIn("内部合同档案（合成）", internal_ok["content"])


class _FakeGuard:
    def __init__(self, attempts):
        self.attempts = attempts


class CaseRunnerTests(unittest.TestCase):
    def test_every_declared_case_passes_with_zero_forbidden_calls(self):
        with tempfile.TemporaryDirectory(prefix="evidence-gate-test-") as workspace:
            with core.NetworkGuard() as guard:
                results = cases.run_all(workspace)
            self.assertEqual(guard.attempts, [])
        self.assertEqual(len(results), len(cases.CASES))
        for result in results:
            failed = [c for c in result["checks"] if not c["passed"]]
            self.assertEqual(failed, [], f"{result['case_id']} failed: {failed}")

    def test_runner_returns_nonzero_on_failed_declared_check(self):
        def failing_case(workspace):
            return {
                "case_id": "deliberate-failure",
                "title": "injected failing case",
                "trace": [],
                "observed_facts": [],
                "checks": [
                    {"name": "deliberately_false", "passed": False, "detail": "injected"}
                ],
            }

        original = cases.CASES
        cases.CASES = (failing_case,)
        try:
            with tempfile.TemporaryDirectory(prefix="evidence-gate-test-") as out:
                with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                    code = run.main(["--output", out])
                self.assertEqual(code, 1)
                with open(os.path.join(out, "receipt.json"), encoding="utf-8") as handle:
                    receipt = json.load(handle)
                self.assertEqual(receipt["automated_verdict"], "rejected")
                self.assertFalse(receipt["summary"]["all_checks_passed"])
                self.assertIn("deliberate-failure", receipt["summary"]["failed_cases"])
                facts = receipt["distinctions"]["observed_facts"]
                self.assertTrue(any("failed checks" in fact for fact in facts), facts)
                self.assertFalse(any(fact.startswith("有效合成") for fact in facts))
        finally:
            cases.CASES = original

    def test_artifact_scan_failure_redacts_and_rejects(self):
        with tempfile.TemporaryDirectory(prefix="evidence-gate-test-") as out:
            with mock.patch.object(
                core, "scan_for_private_material", return_value=["/Users/simulated-marker"]
            ):
                with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                    code = run.main(["--output", out])
            self.assertEqual(code, 1)
            with open(os.path.join(out, "receipt.json"), encoding="utf-8") as handle:
                receipt = json.load(handle)
            self.assertTrue(receipt["redacted"])
            self.assertEqual(receipt["automated_verdict"], "rejected")
            self.assertFalse(receipt["artifact_scan"]["passed"])
            self.assertIn("/Users/simulated-marker", receipt["artifact_scan"]["matches"])
            self.assertNotIn("checks", receipt["cases"][0])
            self.assertIn("check_names", receipt["cases"][0])
            with open(os.path.join(out, "report.md"), encoding="utf-8") as handle:
                report = handle.read()
            self.assertIn("已脱敏", report)

    def test_network_fatal_gate_folds_into_verdict(self):
        passing = [
            {
                "case_id": "ok",
                "title": "ok",
                "trace": [],
                "observed_facts": ["ok fact"],
                "checks": [{"name": "ok_check", "passed": True, "detail": ""}],
            }
        ]
        gates = [
            {
                "name": "network-forbidden-call-observation",
                "passed": False,
                "detail": "attempts=1",
            }
        ]
        receipt = run.build_receipt(passing, _FakeGuard(["socket.create_connection"]), gates)
        self.assertFalse(receipt["summary"]["all_checks_passed"])
        self.assertEqual(receipt["automated_verdict"], "rejected")
        self.assertIn("network-forbidden-call-observation", receipt["summary"]["failed_cases"])

    def test_cli_writes_clean_artifacts_and_returns_zero(self):
        with tempfile.TemporaryDirectory(prefix="evidence-gate-test-") as out:
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                code = run.main(["--output", out])
            self.assertEqual(code, 0)
            with open(os.path.join(out, "receipt.json"), encoding="utf-8") as handle:
                receipt_text = handle.read()
            with open(os.path.join(out, "report.md"), encoding="utf-8") as handle:
                report_text = handle.read()
            receipt = json.loads(receipt_text)
            self.assertEqual(receipt["automated_verdict"], "supported")
            self.assertEqual(receipt["human_choice"], "unreviewed")
            self.assertTrue(receipt["summary"]["all_checks_passed"])
            self.assertEqual(receipt["network"]["requests_attempted"], 0)
            self.assertEqual(receipt["artifact_scan"], {"passed": True, "matches": []})
            self.assertEqual(core.scan_for_private_material(receipt_text + report_text), [])
            self.assertNotIn(os.path.realpath(out), report_text)


if __name__ == "__main__":
    unittest.main(verbosity=2)

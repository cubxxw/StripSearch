"""Offline evidence-gate core for a disposable decision probe.

This is NOT a production research agent. It is a stdlib-only (Python 3.12)
probe that answers one question: can a single canonical report plus a
revision/export gate invalidate identity/evidence dependencies while preserving
unaffected facts in both JSON and Markdown?

Inputs are explicitly authored synthetic annotations, never an NLP extractor.
The probe makes zero network, model or provider calls. See README.md for the
decision receipt, the automated verdict, and the honest limitations.

Official API references used by this file:
- sqlite3: https://docs.python.org/3.12/library/sqlite3.html
- unittest: https://docs.python.org/3.12/library/unittest.html
"""

from __future__ import annotations

import copy
import json
import re
import socket
import sqlite3
import urllib.parse
import urllib.request

SCHEMA_VERSION = "stripsearch/evidence-gate-probe-v1"

# Permission enum. Unknown values fail closed with unknown_export_policy.
PUBLIC_POLICIES = frozenset({"public_synthetic", "public"})
KNOWN_POLICIES = frozenset({"public_synthetic", "public", "private_local", "restricted"})

# Live fetch status is descriptive, not a usability gate: a page that is now
# unreachable must NOT invalidate a legally saved, readable historical snapshot.
# A source is usable only while it retains a body and has not been withdrawn.
# Withdrawal only happens through the explicit apply_source_withdrawal transition.
# (See the decision contract: inaccessible live page vs withdrawn local body.)

CURRENT = "current"
SUPERSEDED = "superseded"

# Closed enums for authored input.
CLAIM_STATUSES = frozenset({"supported", "contradicted", "conflicting", "insufficient_evidence"})
CLAIM_KINDS = frozenset({"factual", "attributed_statement", "inference"})
COVERAGE_STATUSES = frozenset({"answered", "unknown", "blocked"})
IDENTITY_LINK_STATES = frozenset({"linked", "candidate", "rejected", "disputed"})
SNAPSHOT_STATES = frozenset(
    {"completed", "partial", "needs_input", "failed", "cancelled", "resolving", "researching", "verifying"}
)

# Only these top-level keys are structural metadata; everything else is derived
# content and must be recomputed or conservatively omitted on public export.
METADATA_KEYS = (
    "schema_version",
    "run_id",
    "revision",
    "supersedes",
    "as_of",
    "state",
    "synthetic",
    "generated_by",
    "usage",
    "stop_reason",
)

# Public export keeps only typed structural metadata. Free-text metadata such as
# stop_reason / generated_by / usage is internal-only because it has no declared
# provenance contract.
PUBLIC_METADATA_KEYS = (
    "schema_version",
    "run_id",
    "revision",
    "supersedes",
    "as_of",
    "state",
    "synthetic",
)

# Text-bearing fields must declare provenance. Declared provenance is authored
# input (a claim/evidence ID list), not semantic truth; the probe checks the
# source policy of the referenced nodes, not whether the text truly follows.

PRIVATE_PATTERNS = (
    "/Users/",
    "/home/",
    "app.notion.com",
    "notion.so/",
    "Bearer ",
    "sk-",
    "api_key",
    "BEGIN PRIVATE KEY",
)

# Public export uses explicit field whitelists so unknown/internal fields (for
# example an internal_uri private path or a stored body) never leak.
PUBLIC_SOURCE_FIELDS = (
    "source_id",
    "canonical_url",
    "title",
    "origin_group_id",
    "published_at",
    "retrieved_at",
    "fetch_status",
    "snapshot_hash",
    "export_policy",
)
PUBLIC_PERSON_FIELDS = (
    "person_id",
    "identity_status",
    "report_anchor",
    "profile_links",
    "identity_evidence_ids",
)
PUBLIC_CLAIM_FIELDS = (
    "claim_id",
    "person_id",
    "statement",
    "kind",
    "status",
    "support_evidence_ids",
    "refute_evidence_ids",
    "valid_from",
    "valid_to",
    "as_of",
)
PUBLIC_EVIDENCE_FIELDS = ("evidence_id", "source_id", "locator", "excerpt")
PUBLIC_LINK_FIELDS = ("source_id", "person_id", "state", "basis_evidence_ids", "revision")
PUBLIC_EVENT_FIELDS = (
    "event_id",
    "person_id",
    "occurred_at",
    "recorded_at",
    "action_claim_ids",
    "outcome_claim_ids",
    "unknowns",
)
PUBLIC_HYPOTHESIS_FIELDS = (
    "hypothesis_id",
    "person_id",
    "support_event_ids",
    "counter_event_ids",
    "status",
)
PUBLIC_PROFILE_FIELDS = ("url", "verification_status", "evidence_ids")
PUBLIC_COVERAGE_FIELDS = ("question", "status", "claim_ids", "reason")


def _pick(mapping, fields):
    return {field: mapping[field] for field in fields if field in mapping}


def _public_source(source):
    return source.get("export_policy") in PUBLIC_POLICIES


def _all_claimed(provenance, allowed_claim_ids):
    return bool(provenance) and all(c in allowed_claim_ids for c in provenance)


def _all_public_evidence(provenance, evidence, sources):
    if not provenance:
        return False
    for evidence_id in provenance:
        item = evidence.get(evidence_id)
        if item is None or _evidence_inert(item):
            return False
        source = sources.get(item.get("source_id"))
        if source is None or not _public_source(source) or not source_usable(source):
            return False
    return True


class GateError(Exception):
    """A declared gate rejection. Failing inputs are expected rejections."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


class RevisionSuperseded(Exception):
    code = "revision_superseded"

    def __init__(self, run_id: str, revision: int, superseded_by):
        super().__init__(f"{run_id} revision {revision} superseded by {superseded_by}")
        self.run_id = run_id
        self.revision = revision
        self.superseded_by = superseded_by


class ReportNotFound(Exception):
    code = "report_not_found"

    def __init__(self, run_id: str, revision):
        super().__init__(f"{run_id} revision {revision} not found")
        self.run_id = run_id
        self.revision = revision


# ---------------------------------------------------------------------------
# Forbidden-call observation (in-process only; honest about its limits)
# ---------------------------------------------------------------------------


class ForbiddenCall(Exception):
    pass


class NetworkGuard:
    """In-process Python network guard.

    It monkeypatches stdlib socket entry points so any call raises
    ForbiddenCall and is recorded. Honest limit: it covers Python code running
    in this interpreter that reaches the *current* stdlib socket attributes.
    It is NOT an OS sandbox, does not stop subprocesses, C extensions, or
    references cached before the guard was installed, and does not inspect
    kernel syscalls.
    """

    def __init__(self):
        self.attempts = []
        self._saved = {}

    def __enter__(self):
        self.attempts = []
        guard = self

        def blocked(name):
            def _raise(*args, **kwargs):
                guard.attempts.append(name)
                raise ForbiddenCall(name)

            return _raise

        targets = {
            "socket.getaddrinfo": (socket, "getaddrinfo"),
            "socket.create_connection": (socket, "create_connection"),
            "socket.socket.connect": (socket.socket, "connect"),
            "socket.socket.connect_ex": (socket.socket, "connect_ex"),
            "urllib.request.urlopen": (urllib.request, "urlopen"),
        }
        for label, (owner, attr) in targets.items():
            self._saved[label] = getattr(owner, attr)
            setattr(owner, attr, blocked(label))
        return self

    def __exit__(self, exc_type, exc, tb):
        for label, (owner, attr) in {
            "socket.getaddrinfo": (socket, "getaddrinfo"),
            "socket.create_connection": (socket, "create_connection"),
            "socket.socket.connect": (socket.socket, "connect"),
            "socket.socket.connect_ex": (socket.socket, "connect_ex"),
            "urllib.request.urlopen": (urllib.request, "urlopen"),
        }.items():
            setattr(owner, attr, self._saved[label])
        return False


# ---------------------------------------------------------------------------
# Snapshot helpers
# ---------------------------------------------------------------------------


def _index_unique(items, key, kind):
    out = {}
    for item in items:
        ident = item.get(key)
        if ident is None:
            raise GateError("missing_id", f"{kind} is missing {key}")
        if ident in out:
            raise GateError("duplicate_id", f"duplicate {kind} {key}={ident}")
        out[ident] = item
    return out


def source_usable(source) -> bool:
    """A historical snapshot body is usable while present and not withdrawn.

    ``fetch_status`` records the live retrieval attempt and does not by itself
    invalidate a legally saved body. Withdrawal removes the body explicitly.
    """

    return source.get("body") is not None and not source.get("withdrawn")


def _evidence_inert(evidence) -> bool:
    return bool(evidence.get("withdrawn"))


def _evidence_basis_ok(snapshot, evidence_id, evidence_index, source_index):
    evidence = evidence_index.get(evidence_id)
    if evidence is None:
        return False, "basis_missing"
    if _evidence_inert(evidence):
        return False, "basis_withdrawn"
    source = source_index.get(evidence.get("source_id"))
    if source is None:
        return False, "basis_source_missing"
    if not source_usable(source):
        return False, "basis_source_unusable"
    excerpt = evidence.get("excerpt")
    if not isinstance(excerpt, str) or excerpt not in source["body"]:
        return False, "basis_excerpt_missing"
    return True, None


def link_eligibility(snapshot, is_public_source=None):
    """Return {(person_id, source_id): (eligible: bool, reason: str|None)}.

    A link is base-valid when its state is ``linked`` and every basis evidence
    is a readable, exactly-present excerpt. Eligibility is the least fixpoint
    from *seeds*: links whose basis is entirely self-source (no cross-source
    dependency). A link with any cross-source basis requires every declared
    cross-source dependency to be eligible; a self-source excerpt is a support
    record and cannot waive required cross dependencies. Pure or mixed
    cross-source cycles with no seed therefore stay ineligible.

    ``is_public_source`` optionally restricts the graph to public-permitted
    sources: a link is a candidate only if its own source and every basis
    evidence source satisfy the predicate. Cross dependencies outside the
    permitted graph are unsatisfiable, so public eligibility is closed to a
    fixed point over the public subgraph (no dangling identity support).
    """

    people = _index_unique(snapshot.get("people_index", []), "person_id", "person")
    sources = _index_unique(snapshot.get("sources", []), "source_id", "source")
    evidence = _index_unique(snapshot.get("evidence", []), "evidence_id", "evidence")
    links = snapshot.get("identity_links", [])

    result = {}
    candidates = {}
    seeds = set()
    for link in links:
        key = (link.get("person_id"), link.get("source_id"))
        if key in result:
            continue
        bases = link.get("basis_evidence_ids")
        valid = True
        reason = None
        if not bases:
            valid, reason = False, "no_basis"
        else:
            for evidence_id in bases:
                ok, why = _evidence_basis_ok(snapshot, evidence_id, evidence, sources)
                if not ok:
                    valid, reason = False, why
                    break
        if not valid:
            result[key] = (False, reason)
            continue
        # Non-linked states are ineligible and never enter the fixpoint.
        if link.get("state") != "linked":
            result[key] = (False, f"state_{link.get('state')}")
            continue
        if link.get("person_id") not in people or link.get("source_id") not in sources:
            result[key] = (False, "dangling_link")
            continue
        if not source_usable(sources[link["source_id"]]):
            result[key] = (False, "source_unusable")
            continue
        if is_public_source is not None:
            if not is_public_source(sources[link["source_id"]]):
                result[key] = (False, "policy_restricted")
                continue
            if any(
                not is_public_source(sources[evidence[e]["source_id"]]) for e in bases
            ):
                result[key] = (False, "policy_restricted")
                continue
        cross = {
            (link["person_id"], evidence[e]["source_id"])
            for e in bases
            if evidence[e]["source_id"] != link["source_id"]
        }
        candidates[key] = cross
        if not cross:
            seeds.add(key)
        result[key] = (False, "unanchored")

    eligible = set(seeds)
    changed = True
    while changed:
        changed = False
        for key, cross in candidates.items():
            if key in eligible or not cross:
                continue
            if all(dep in eligible for dep in cross):
                eligible.add(key)
                changed = True

    for key in eligible:
        result[key] = (True, None)
    return result


def _unanchored_cycle(snapshot):
    """Return a cross-source identity cycle with no independent seed.

    A cycle in the cross-dependency graph cannot contain a seed (seeds have no
    cross dependencies), so any cycle is unsupported and must be rejected.
    Samples are tiny, so a small iterative WHITE/GRAY/BLACK depth-first search
    is enough; no general expression DSL.
    """

    sources = _index_unique(snapshot.get("sources", []), "source_id", "source")
    evidence = _index_unique(snapshot.get("evidence", []), "evidence_id", "evidence")
    links = snapshot.get("identity_links", [])

    deps = {}
    for link in links:
        key = (link.get("person_id"), link.get("source_id"))
        if link.get("state") != "linked":
            continue
        bases = link.get("basis_evidence_ids") or []
        if not bases or any(e not in evidence for e in bases):
            continue
        if any(
            _evidence_inert(evidence[e])
            or evidence[e].get("source_id") not in sources
            or not source_usable(sources[evidence[e]["source_id"]])
            or evidence[e].get("excerpt") not in sources[evidence[e]["source_id"]]["body"]
            for e in bases
        ):
            continue
        deps[key] = {
            (link["person_id"], evidence[e]["source_id"])
            for e in bases
            if evidence[e]["source_id"] != link["source_id"]
        }

    WHITE, GRAY, BLACK = 0, 1, 2
    color = {node: WHITE for node in deps}
    for start in sorted(deps, key=str):
        if color[start] != WHITE:
            continue
        color[start] = GRAY
        path = [start]
        stack = [(start, iter(sorted(deps.get(start, set()))))]
        while stack:
            node, edges = stack[-1]
            advanced = False
            for nxt in edges:
                if nxt not in deps:
                    continue
                if color.get(nxt) == GRAY:
                    return path[path.index(nxt):]
                if color.get(nxt) == WHITE:
                    color[nxt] = GRAY
                    path.append(nxt)
                    stack.append((nxt, iter(sorted(deps.get(nxt, set())))))
                    advanced = True
                    break
            if not advanced:
                color[node] = BLACK
                path.pop()
                stack.pop()
    return None


def validate_snapshot(snapshot):
    """Fail-closed structural, referential and eligibility gate.

    Raises GateError on the first violation. Invalidated nodes are inert: their
    foreign keys still must exist, but they are not required to have eligible
    identity links (they are excluded from every export).
    """

    if not isinstance(snapshot, dict):
        raise GateError("invalid_snapshot", "snapshot must be a mapping")
    if snapshot.get("schema_version") != SCHEMA_VERSION:
        raise GateError("unknown_schema_version", str(snapshot.get("schema_version")))
    revision = snapshot.get("revision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        raise GateError("invalid_revision", "revision must be a positive int")
    if snapshot.get("supersedes") is not None and (
        not isinstance(snapshot["supersedes"], int) or isinstance(snapshot["supersedes"], bool)
    ):
        raise GateError("invalid_supersedes", "supersedes must be an int or null")
    if snapshot.get("state") is not None and snapshot["state"] not in SNAPSHOT_STATES:
        raise GateError("invalid_state", str(snapshot.get("state")))
    for field in ("run_id", "as_of"):
        if not snapshot.get(field):
            raise GateError("missing_field", field)

    people = _index_unique(snapshot.get("people_index", []), "person_id", "person")
    sources = _index_unique(snapshot.get("sources", []), "source_id", "source")
    evidence = _index_unique(snapshot.get("evidence", []), "evidence_id", "evidence")
    claims = _index_unique(snapshot.get("claims", []), "claim_id", "claim")
    events = _index_unique(snapshot.get("events", []), "event_id", "event")
    hypotheses = _index_unique(
        snapshot.get("behavior_hypotheses", []), "hypothesis_id", "hypothesis"
    )

    seen_links = set()
    for link in snapshot.get("identity_links", []):
        key = (link.get("person_id"), link.get("source_id"))
        if key in seen_links:
            raise GateError("duplicate_id", f"duplicate identity link {key}")
        seen_links.add(key)
        for field in ("person_id", "source_id", "state"):
            if not link.get(field):
                raise GateError("missing_field", f"identity link missing {field}")
        if link.get("state") not in IDENTITY_LINK_STATES:
            raise GateError("invalid_link_state", str(link.get("state")))

    # Unknown permission values fail closed before any eligibility decision.
    for source in sources.values():
        policy = source.get("export_policy")
        if policy not in KNOWN_POLICIES:
            raise GateError("unknown_export_policy", f"{source['source_id']}={policy!r}")
        if source.get("withdrawn") and source.get("body") is not None:
            raise GateError("withdrawn_source_has_body", source["source_id"])

    # Evidence must point at a usable source and quote it exactly, unless it is
    # explicitly inert because its source was withdrawn. Inert evidence must not
    # keep a usable excerpt and must belong to a withdrawn source; this stops an
    # authored snapshot from hiding inconsistent active evidence behind a flag.
    for item in evidence.values():
        source_id = item.get("source_id")
        if source_id not in sources:
            raise GateError("unknown_reference", f"evidence {item.get('evidence_id')} -> {source_id}")
        source = sources[source_id]
        if _evidence_inert(item):
            if not source.get("withdrawn"):
                raise GateError(
                    "withdrawn_evidence_without_withdrawn_source",
                    item.get("evidence_id"),
                )
            if item.get("excerpt"):
                raise GateError(
                    "withdrawn_evidence_has_excerpt", item.get("evidence_id")
                )
            continue
        if source.get("withdrawn"):
            raise GateError("withdrawn_source_active_evidence", item.get("evidence_id"))
        if not source_usable(source):
            raise GateError("source_inaccessible", f"{source_id} has no usable body")
        excerpt = item.get("excerpt")
        if not isinstance(excerpt, str) or not excerpt:
            raise GateError("missing_excerpt", f"evidence {item.get('evidence_id')}")
        if excerpt not in source["body"]:
            raise GateError("excerpt_not_found", f"evidence {item.get('evidence_id')}")

    # Identity link references.
    for link in snapshot.get("identity_links", []):
        if link.get("person_id") not in people:
            raise GateError("unknown_reference", f"identity link person {link.get('person_id')}")
        if link.get("source_id") not in sources:
            raise GateError("unknown_reference", f"identity link source {link.get('source_id')}")
        for evidence_id in link.get("basis_evidence_ids", []):
            if evidence_id not in evidence:
                raise GateError("unknown_reference", f"identity basis {evidence_id}")

    cycle = _unanchored_cycle(snapshot)
    if cycle:
        raise GateError(
            "identity_cycle",
            "cross-source identity basis cycle without anchor: "
            + " -> ".join(str(m) for m in cycle),
        )

    eligibility = link_eligibility(snapshot)

    # People index identity/profile evidence must resolve and stay linked.
    for person in people.values():
        person_id = person["person_id"]
        for evidence_id in person.get("identity_evidence_ids", []):
            if evidence_id not in evidence:
                raise GateError("unknown_reference", f"person identity evidence {evidence_id}")
            if _evidence_inert(evidence[evidence_id]):
                raise GateError(
                    "profile_references_withdrawn_evidence",
                    f"{person_id} identity evidence {evidence_id}",
                )
            source_id = evidence[evidence_id]["source_id"]
            if not eligibility.get((person_id, source_id), (False,))[0]:
                raise GateError(
                    "profile_source_unlinked",
                    f"{person_id} identity evidence {evidence_id} source unlinked",
                )
        for profile in person.get("profile_links", []):
            evidence_ids = profile.get("evidence_ids", [])
            if not evidence_ids:
                raise GateError("profile_source_unlinked", f"{person_id} profile without evidence")
            for evidence_id in evidence_ids:
                if evidence_id not in evidence:
                    raise GateError("unknown_reference", f"profile evidence {evidence_id}")
                if _evidence_inert(evidence[evidence_id]):
                    raise GateError(
                        "profile_references_withdrawn_evidence",
                        f"{person_id} profile evidence {evidence_id}",
                    )
                source_id = evidence[evidence_id]["source_id"]
                if not eligibility.get((person_id, source_id), (False,))[0]:
                    raise GateError(
                        "profile_source_unlinked",
                        f"{person_id} profile evidence {evidence_id} source unlinked",
                    )

    # Claims: person must exist; evidence refs must exist; active claims need an
    # eligible identity link before any support is accepted.
    for claim in claims.values():
        person_id = claim.get("person_id")
        if person_id not in people:
            raise GateError("unknown_reference", f"claim {claim['claim_id']} person {person_id}")
        if claim.get("kind") not in CLAIM_KINDS:
            raise GateError("invalid_claim_kind", f"{claim['claim_id']}={claim.get('kind')!r}")
        if claim.get("status") not in CLAIM_STATUSES:
            raise GateError("invalid_claim_status", f"{claim['claim_id']}={claim.get('status')!r}")
        refs = list(claim.get("support_evidence_ids", [])) + list(
            claim.get("refute_evidence_ids", [])
        )
        for evidence_id in refs:
            if evidence_id not in evidence:
                raise GateError("unknown_reference", f"claim {claim['claim_id']} -> {evidence_id}")
        if claim.get("invalidated_reason"):
            continue
        for evidence_id in refs:
            if _evidence_inert(evidence[evidence_id]):
                raise GateError(
                    "claim_references_withdrawn_evidence", claim["claim_id"]
                )
        # Known statuses require their declared dependency; insufficient_evidence
        # is allowed without support and is not silently upgraded.
        support = claim.get("support_evidence_ids", [])
        refute = claim.get("refute_evidence_ids", [])
        if claim["status"] == "supported" and not support:
            raise GateError("claim_missing_support", claim["claim_id"])
        if claim["status"] == "contradicted" and not refute:
            raise GateError("claim_missing_refute", claim["claim_id"])
        if claim["status"] == "conflicting" and not (support and refute):
            raise GateError("claim_missing_evidence", claim["claim_id"])
        for evidence_id in refs:
            source_id = evidence[evidence_id]["source_id"]
            if not eligibility.get((person_id, source_id), (False,))[0]:
                raise GateError(
                    "claim_source_unlinked",
                    f"claim {claim['claim_id']} uses source {source_id} without an eligible link",
                )

    # Events: referenced claims must exist and belong to the same person. An
    # active event may not lean on an invalidated claim.
    for event in events.values():
        person_id = event.get("person_id")
        if person_id not in people:
            raise GateError("unknown_reference", f"event {event['event_id']} person {person_id}")
        for claim_id in list(event.get("action_claim_ids", [])) + list(
            event.get("outcome_claim_ids", [])
        ):
            if claim_id not in claims:
                raise GateError("unknown_reference", f"event {event['event_id']} -> {claim_id}")
            if claims[claim_id].get("person_id") != person_id:
                raise GateError(
                    "claim_person_mismatch",
                    f"event {event['event_id']} cross-person claim {claim_id}",
                )
            if not event.get("invalidated_reason") and claims[claim_id].get("invalidated_reason"):
                raise GateError(
                    "event_references_invalidated_claim",
                    f"event {event['event_id']} -> {claim_id}",
                )

    # Hypotheses: referenced events must exist and belong to the same person. An
    # active hypothesis may not lean on an invalidated event.
    for hypothesis in hypotheses.values():
        person_id = hypothesis.get("person_id")
        if person_id not in people:
            raise GateError("unknown_reference", f"hypothesis {hypothesis['hypothesis_id']} person")
        for event_id in list(hypothesis.get("support_event_ids", [])) + list(
            hypothesis.get("counter_event_ids", [])
        ):
            if event_id not in events:
                raise GateError("unknown_reference", f"hypothesis -> {event_id}")
            if events[event_id].get("person_id") != person_id:
                raise GateError(
                    "claim_person_mismatch",
                    f"hypothesis {hypothesis['hypothesis_id']} cross-person event {event_id}",
                )
            if not hypothesis.get("invalidated_reason") and events[event_id].get(
                "invalidated_reason"
            ):
                raise GateError(
                    "hypothesis_references_invalidated_event",
                    f"hypothesis {hypothesis['hypothesis_id']} -> {event_id}",
                )

    # Coverage claim references and status enum. Answered coverage may not point
    # at an invalidated claim.
    for entry in snapshot.get("coverage", []):
        if entry.get("status") not in COVERAGE_STATUSES:
            raise GateError("invalid_coverage_status", str(entry.get("status")))
        for claim_id in entry.get("claim_ids", []):
            if claim_id not in claims:
                raise GateError("unknown_reference", f"coverage -> {claim_id}")
            if entry.get("status") == "answered" and claims[claim_id].get("invalidated_reason"):
                raise GateError(
                    "coverage_references_invalidated_claim",
                    f"coverage -> {claim_id}",
                )
    return snapshot


# ---------------------------------------------------------------------------
# Dependency recomputation after identity revocation
# ---------------------------------------------------------------------------


def _eligible_source_set(snapshot, eligibility, person_id):
    return {
        source_id
        for (pid, source_id), (ok, _reason) in eligibility.items()
        if pid == person_id and ok
    }


def recompute_dependencies(snapshot):
    """Conservatively invalidate nodes with ineligible identity dependencies.

    Claims whose evidence is withdrawn or sits on a source without an eligible
    link for the claim's person are invalidated; events that use invalidated
    claims, hypotheses that use invalidated events, answered coverage that used
    invalidated claims, and verified profiles that lost their link are all
    invalidated. Unrelated branches are left untouched. Mirrors the invariant
    IdentityLink -> Claim -> Event -> Hypothesis -> Report revision.
    """

    eligibility = link_eligibility(snapshot)
    people = {p["person_id"]: p for p in snapshot.get("people_index", [])}
    evidence = {e["evidence_id"]: e for e in snapshot.get("evidence", [])}

    invalid_claims = set()
    for claim in snapshot.get("claims", []):
        if claim.get("invalidated_reason"):
            invalid_claims.add(claim["claim_id"])
            continue
        person_id = claim["person_id"]
        allowed = _eligible_source_set(snapshot, eligibility, person_id)
        refs = list(claim.get("support_evidence_ids", [])) + list(
            claim.get("refute_evidence_ids", [])
        )
        bad = sorted(
            {
                evidence[e]["source_id"]
                for e in refs
                if e in evidence
                and (
                    _evidence_inert(evidence[e])
                    or evidence[e]["source_id"] not in allowed
                )
            }
        )
        if bad:
            claim["status"] = "insufficient_evidence"
            claim["invalidated_reason"] = "identity_link_ineligible:" + ",".join(bad)
            invalid_claims.add(claim["claim_id"])

    invalid_events = set()
    for event in snapshot.get("events", []):
        if event.get("invalidated_reason"):
            invalid_events.add(event["event_id"])
            continue
        if any(
            c in invalid_claims
            for c in list(event.get("action_claim_ids", [])) + list(event.get("outcome_claim_ids", []))
        ):
            event["invalidated_reason"] = "dependent_claim_invalidated"
            invalid_events.add(event["event_id"])

    for hypothesis in snapshot.get("behavior_hypotheses", []):
        if hypothesis.get("invalidated_reason"):
            continue
        if any(
            e in invalid_events
            for e in list(hypothesis.get("support_event_ids", []))
            + list(hypothesis.get("counter_event_ids", []))
        ):
            hypothesis["invalidated_reason"] = "dependent_event_invalidated"

    for entry in snapshot.get("coverage", []):
        if entry.get("status") == "answered" and any(
            c in invalid_claims for c in entry.get("claim_ids", [])
        ):
            entry["status"] = "blocked"
            entry["reason"] = "dependent_claim_invalidated"
            entry["claim_ids"] = [c for c in entry.get("claim_ids", []) if c not in invalid_claims]

    for person in people.values():
        person_id = person["person_id"]
        allowed = _eligible_source_set(snapshot, eligibility, person_id)
        person["identity_evidence_ids"] = [
            e
            for e in person.get("identity_evidence_ids", [])
            if e in evidence
            and not _evidence_inert(evidence[e])
            and evidence[e]["source_id"] in allowed
        ]
        kept_profiles = []
        for profile in person.get("profile_links", []):
            evidence_ids = profile.get("evidence_ids", [])
            if evidence_ids and all(
                e in evidence
                and not _evidence_inert(evidence[e])
                and evidence[e]["source_id"] in allowed
                for e in evidence_ids
            ):
                kept_profiles.append(profile)
            else:
                profile["verification_status"] = "revoked"
        person["profile_links"] = kept_profiles
        person["identity_status"] = "resolved" if kept_profiles or person["identity_evidence_ids"] else "unresolved"
    return snapshot


def apply_identity_revocation(snapshot, person_id, source_id, new_state="rejected"):
    """Return a new revision with one identity link revoked/rejected.

    Does not mutate the input snapshot. Writes are transactional at the store
    layer; a malformed revision never supersedes a valid report.
    """

    new = copy.deepcopy(snapshot)
    link = None
    for candidate in new.get("identity_links", []):
        if candidate.get("person_id") == person_id and candidate.get("source_id") == source_id:
            link = candidate
            break
    if link is None:
        raise GateError("unknown_identity_link", f"{person_id}/{source_id}")
    link["state"] = new_state
    link["revision"] = int(link.get("revision", 1)) + 1
    recompute_dependencies(new)
    new["revision"] = int(snapshot["revision"]) + 1
    new["supersedes"] = int(snapshot["revision"])
    return new


def apply_source_withdrawal(snapshot, source_id):
    """Return a new revision where a source's local usable body is withdrawn.

    This is the *legal withdrawal* transition, distinct from a failed retrieval:
    an unreachable live page does not invalidate a saved body, but explicitly
    withdrawing the local body does. The new snapshot keeps inert provenance and
    references for audit (source record, locator, evidence id) while removing the
    usable body and excerpts. Dependents are recomputed: withdrawn-basis links
    become ineligible and dependent claims/events/hypotheses/coverage/profiles
    are conservatively invalidated. Storing the new revision atomically in the
    revision store supersedes the old export. This is logical withdrawal, not
    secure erasure of history.
    """

    new = copy.deepcopy(snapshot)
    source = None
    for candidate in new.get("sources", []):
        if candidate.get("source_id") == source_id:
            source = candidate
            break
    if source is None:
        raise GateError("unknown_source", source_id)
    source["withdrawn"] = True
    source["body"] = None
    for item in new.get("evidence", []):
        if item.get("source_id") == source_id:
            item["withdrawn"] = True
            item.pop("excerpt", None)
    recompute_dependencies(new)
    new["revision"] = int(snapshot["revision"]) + 1
    new["supersedes"] = int(snapshot["revision"])
    return new


# ---------------------------------------------------------------------------
# SQLite revision store (immutable snapshots, transactional status changes)
# ---------------------------------------------------------------------------

_SCHEMA = """
CREATE TABLE IF NOT EXISTS revisions (
    run_id   TEXT    NOT NULL,
    revision INTEGER NOT NULL,
    status   TEXT    NOT NULL CHECK (status IN ('current', 'superseded')),
    payload  TEXT    NOT NULL,
    PRIMARY KEY (run_id, revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_current_revision
ON revisions(run_id) WHERE status = 'current';
CREATE TRIGGER IF NOT EXISTS revisions_payload_immutable
BEFORE UPDATE OF payload ON revisions
BEGIN
    SELECT RAISE(ABORT, 'snapshot payload is immutable');
END;
"""


class SnapshotStore:
    """SQLite-backed immutable report revisions.

    ``add_revision`` validates first and then changes current->superseded and
    inserts the new current inside a single transaction, so a malformed
    revision cannot supersede a valid report. Reading a superseded revision
    raises ``RevisionSuperseded``, including after reconnecting.
    """

    def __init__(self, path=":memory:"):
        self.path = path
        self.conn = sqlite3.connect(path)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(_SCHEMA)
        self.conn.commit()

    def close(self):
        self.conn.close()

    def add_revision(self, snapshot):
        # Fail closed before touching the database.
        validate_snapshot(snapshot)
        run_id = snapshot["run_id"]
        revision = snapshot["revision"]
        payload = json.dumps(snapshot, ensure_ascii=False, sort_keys=True)
        try:
            with self.conn:  # BEGIN ... COMMIT / ROLLBACK
                # Lock before reading the parent, not only at the first UPDATE.
                # https://www.sqlite.org/lang_transaction.html
                self.conn.execute("BEGIN IMMEDIATE")
                previous = self.conn.execute(
                    "SELECT revision FROM revisions WHERE run_id=? ORDER BY revision DESC LIMIT 1",
                    (run_id,),
                ).fetchone()
                if previous is not None and revision <= previous["revision"]:
                    raise GateError(
                        "non_monotonic_revision",
                        f"{run_id}: {revision} <= {previous['revision']}",
                    )
                expected_parent = previous["revision"] if previous is not None else None
                if snapshot.get("supersedes") != expected_parent:
                    raise GateError("stale_revision", "revision parent is not the current snapshot")
                self.conn.execute(
                    "UPDATE revisions SET status=? WHERE run_id=? AND status=?",
                    (SUPERSEDED, run_id, CURRENT),
                )
                self.conn.execute(
                    "INSERT INTO revisions (run_id, revision, status, payload) VALUES (?, ?, ?, ?)",
                    (run_id, revision, CURRENT, payload),
                )
        except GateError:
            raise

    def _row(self, run_id, revision):
        row = self.conn.execute(
            "SELECT revision, status, payload FROM revisions WHERE run_id=? AND revision=?",
            (run_id, revision),
        ).fetchone()
        if row is None:
            raise ReportNotFound(run_id, revision)
        return row

    def read_revision(self, run_id, revision):
        row = self._row(run_id, revision)
        if row["status"] == SUPERSEDED:
            nxt = self.conn.execute(
                "SELECT MIN(revision) AS r FROM revisions WHERE run_id=? AND revision>?",
                (run_id, revision),
            ).fetchone()["r"]
            raise RevisionSuperseded(run_id, revision, nxt)
        return json.loads(row["payload"])

    def read_current(self, run_id):
        row = self.conn.execute(
            "SELECT revision, payload FROM revisions WHERE run_id=? AND status=? "
            "ORDER BY revision DESC LIMIT 1",
            (run_id, CURRENT),
        ).fetchone()
        if row is None:
            raise ReportNotFound(run_id, None)
        return json.loads(row["payload"])

    def revisions(self, run_id):
        rows = self.conn.execute(
            "SELECT revision, status FROM revisions WHERE run_id=? ORDER BY revision",
            (run_id,),
        ).fetchall()
        return [(r["revision"], r["status"]) for r in rows]


# ---------------------------------------------------------------------------
# Views and exports
# ---------------------------------------------------------------------------


def _metadata(snapshot):
    return {key: snapshot[key] for key in METADATA_KEYS if key in snapshot}


def _evidence_map(snapshot):
    return {e["evidence_id"]: e for e in snapshot.get("evidence", [])}


def _source_map(snapshot):
    return {s["source_id"]: s for s in snapshot.get("sources", [])}


def build_internal_view(snapshot):
    """Current internal export: invalidated conclusions are excluded, but
    restricted (private) material is kept because the audience is internal."""

    validate_snapshot(snapshot)
    active_claims = [c for c in snapshot.get("claims", []) if not c.get("invalidated_reason")]
    active_claim_ids = {c["claim_id"] for c in active_claims}

    events = [
        e
        for e in snapshot.get("events", [])
        if not e.get("invalidated_reason")
        and all(
            c in active_claim_ids
            for c in list(e.get("action_claim_ids", [])) + list(e.get("outcome_claim_ids", []))
        )
    ]
    event_ids = {e["event_id"] for e in events}

    hypotheses = [
        h
        for h in snapshot.get("behavior_hypotheses", [])
        if not h.get("invalidated_reason")
        and all(
            e in event_ids
            for e in list(h.get("support_event_ids", [])) + list(h.get("counter_event_ids", []))
        )
    ]

    coverage = []
    for entry in snapshot.get("coverage", []):
        claim_ids = entry.get("claim_ids", [])
        if entry.get("status") == "answered" and any(c not in active_claim_ids for c in claim_ids):
            coverage.append(
                {
                    **entry,
                    "status": "blocked",
                    "reason": "dependent_claim_invalidated",
                    "claim_ids": [],
                }
            )
        else:
            coverage.append(entry)

    used_evidence = set()
    for claim in active_claims:
        used_evidence |= set(claim.get("support_evidence_ids", []))
        used_evidence |= set(claim.get("refute_evidence_ids", []))
    for link in snapshot.get("identity_links", []):
        used_evidence |= set(link.get("basis_evidence_ids", []))
    for person in snapshot.get("people_index", []):
        used_evidence |= set(person.get("identity_evidence_ids", []))
        for profile in person.get("profile_links", []):
            used_evidence |= set(profile.get("evidence_ids", []))
    # Keep inert (withdrawn) evidence records for audit; the renderer marks them
    # and never prints a withdrawn excerpt.
    used_evidence |= {
        e["evidence_id"] for e in snapshot.get("evidence", []) if _evidence_inert(e)
    }

    evidence = [e for e in snapshot.get("evidence", []) if e["evidence_id"] in used_evidence]
    source_ids = {e["source_id"] for e in evidence}

    view = _metadata(snapshot)
    view.update(
        {
            "audience": "internal",
            "people_index": snapshot.get("people_index", []),
            "identity_links": snapshot.get("identity_links", []),
            "sources": [s for s in snapshot.get("sources", []) if s["source_id"] in source_ids],
            "evidence": evidence,
            "claims": active_claims,
            "events": events,
            "behavior_hypotheses": hypotheses,
            "coverage": coverage,
            "unknowns": snapshot.get("unknowns", []),
        }
    )
    return view


def build_public_view(snapshot):
    """Fail-closed public export.

    Identity eligibility is recomputed on the public-permitted subgraph to a
    fixed point, so a public source whose cross-source identity basis is
    restricted cannot re-enter through a private hop. Every text-bearing field
    additionally needs explicit all-public provenance; fields or nodes with
    missing or restricted provenance are omitted rather than trusted. Unknown
    policies are rejected by validate_snapshot before any export.
    """

    validate_snapshot(snapshot)
    eligibility = link_eligibility(snapshot, is_public_source=_public_source)
    evidence = _evidence_map(snapshot)
    sources = _source_map(snapshot)

    public_link = {}
    for link in snapshot.get("identity_links", []):
        key = (link["person_id"], link["source_id"])
        if eligibility.get(key, (False,))[0]:
            public_link[key] = link

    kept_evidence = set()

    kept_people = []
    for person in snapshot.get("people_index", []):
        person_id = person["person_id"]
        if not any(key[0] == person_id for key in public_link):
            continue
        if not _all_public_evidence(person.get("display_name_provenance"), evidence, sources):
            continue
        name_evidence = person["display_name_provenance"]
        if not all(
            eligibility.get((person_id, evidence[e]["source_id"]), (False,))[0]
            for e in name_evidence
        ):
            continue
        kept_evidence.update(name_evidence)
        identity_evidence = []
        for evidence_id in person.get("identity_evidence_ids", []):
            item = evidence.get(evidence_id)
            if (
                item is not None
                and not _evidence_inert(item)
                and eligibility.get((person_id, item["source_id"]), (False,))[0]
            ):
                identity_evidence.append(evidence_id)
        profiles = []
        for profile in person.get("profile_links", []):
            evidence_ids = profile.get("evidence_ids", [])
            if not evidence_ids:
                continue
            if all(
                e in evidence
                and not _evidence_inert(evidence[e])
                and eligibility.get((person_id, evidence[e]["source_id"]), (False,))[0]
                for e in evidence_ids
            ):
                profiles.append(_pick(profile, PUBLIC_PROFILE_FIELDS))
                kept_evidence |= set(evidence_ids)
        kept_evidence |= set(identity_evidence)
        public_person = _pick(person, PUBLIC_PERSON_FIELDS)
        public_person["display_name"] = person.get("display_name")
        public_person["display_name_provenance"] = list(name_evidence)
        public_person["profile_links"] = profiles
        public_person["identity_evidence_ids"] = identity_evidence
        kept_people.append(public_person)

    public_person_ids = {person["person_id"] for person in kept_people}
    public_link = {key: link for key, link in public_link.items() if key[0] in public_person_ids}
    for link in public_link.values():
        kept_evidence.update(link.get("basis_evidence_ids", []))

    kept_claims = []
    for claim in snapshot.get("claims", []):
        if claim.get("invalidated_reason"):
            continue
        person_id = claim["person_id"]
        if person_id not in public_person_ids:
            continue
        support = claim.get("support_evidence_ids", [])
        if not support:
            continue
        refs = list(support) + list(claim.get("refute_evidence_ids", []))
        if any(
            e not in evidence
            or _evidence_inert(evidence[e])
            or not eligibility.get((person_id, evidence[e]["source_id"]), (False,))[0]
            for e in refs
        ):
            continue
        kept_claims.append(claim)
        kept_evidence |= set(refs)
    kept_claim_ids = {c["claim_id"] for c in kept_claims}

    kept_events = []
    for event in snapshot.get("events", []):
        if event.get("invalidated_reason"):
            continue
        refs = list(event.get("action_claim_ids", [])) + list(event.get("outcome_claim_ids", []))
        if not _all_claimed(refs, kept_claim_ids):
            continue
        public_event = _pick(event, PUBLIC_EVENT_FIELDS)
        if _all_claimed(event.get("context_provenance"), kept_claim_ids):
            public_event["context"] = event.get("context")
        unknowns = []
        for unknown in event.get("unknowns", []):
            if isinstance(unknown, dict) and _all_claimed(
                unknown.get("provenance"), kept_claim_ids
            ):
                unknowns.append({"text": unknown.get("text")})
        public_event["unknowns"] = unknowns
        kept_events.append(public_event)
    kept_event_ids = {e["event_id"] for e in kept_events}

    kept_hypotheses = []
    for hypothesis in snapshot.get("behavior_hypotheses", []):
        if hypothesis.get("invalidated_reason"):
            continue
        support = list(hypothesis.get("support_event_ids", []))
        counter = list(hypothesis.get("counter_event_ids", []))
        if not all(e in kept_event_ids for e in support + counter):
            continue
        if not _all_claimed(hypothesis.get("statement_provenance"), kept_claim_ids):
            continue
        public_hypothesis = _pick(hypothesis, PUBLIC_HYPOTHESIS_FIELDS)
        public_hypothesis["statement"] = hypothesis.get("statement")
        alternatives = []
        alternative_provenance = hypothesis.get("alternatives_provenance") or []
        for index, alternative in enumerate(hypothesis.get("alternatives", [])):
            provenance = alternative_provenance[index] if index < len(alternative_provenance) else None
            if _all_claimed(provenance, kept_claim_ids):
                alternatives.append(alternative)
        public_hypothesis["alternatives"] = alternatives
        if _all_claimed(hypothesis.get("falsifier_provenance"), kept_claim_ids):
            public_hypothesis["falsifier"] = hypothesis.get("falsifier")
        kept_hypotheses.append(public_hypothesis)

    kept_coverage = []
    for entry in snapshot.get("coverage", []):
        claim_ids = entry.get("claim_ids", [])
        if not all(c in kept_claim_ids for c in claim_ids):
            continue
        provenance = entry.get("provenance") or claim_ids
        if not _all_claimed(provenance, kept_claim_ids):
            continue
        public_entry = _pick(entry, PUBLIC_COVERAGE_FIELDS)
        reason_provenance = entry.get("reason_provenance") or claim_ids
        if entry.get("reason") and _all_claimed(reason_provenance, kept_claim_ids):
            public_entry["reason"] = entry["reason"]
        else:
            public_entry.pop("reason", None)
        kept_coverage.append(public_entry)

    kept_unknowns = []
    for unknown in snapshot.get("unknowns", []):
        if not isinstance(unknown, dict):
            continue
        provenance = unknown.get("provenance") or unknown.get("derived_from_claim_ids")
        if not _all_claimed(provenance, kept_claim_ids):
            continue
        kept_unknowns.append(
            {
                "unknown_id": unknown.get("unknown_id"),
                "text": unknown.get("text"),
                "provenance": list(provenance),
            }
        )

    source_ids = {evidence[e]["source_id"] for e in kept_evidence if e in evidence}
    source_ids.update(link["source_id"] for link in public_link.values())
    kept_sources = [
        _pick(source, PUBLIC_SOURCE_FIELDS)
        for source in snapshot.get("sources", [])
        if source["source_id"] in source_ids
        and _public_source(source)
        and not source.get("withdrawn")
    ]

    view = {key: snapshot[key] for key in PUBLIC_METADATA_KEYS if key in snapshot}
    view.update(
        {
            "audience": "public",
            "people_index": kept_people,
            "identity_links": [_pick(link, PUBLIC_LINK_FIELDS) for link in public_link.values()],
            "sources": kept_sources,
            "evidence": [
                _pick(e, PUBLIC_EVIDENCE_FIELDS)
                for e in snapshot.get("evidence", [])
                if e["evidence_id"] in kept_evidence and not _evidence_inert(e)
            ],
            "claims": [_pick(c, PUBLIC_CLAIM_FIELDS) for c in kept_claims],
            "events": kept_events,
            "behavior_hypotheses": kept_hypotheses,
            "coverage": kept_coverage,
            "unknowns": kept_unknowns,
        }
    )
    return view


# ---------------------------------------------------------------------------
# Deterministic renderers (pure; never change state or call a provider)
# ---------------------------------------------------------------------------

_ANCHOR_RE = re.compile(r"[^A-Za-z0-9_-]+")


def _anchor(value):
    cleaned = _ANCHOR_RE.sub("-", str(value or ""))
    return cleaned or "anchor"


def _escape_text(value):
    if value is None:
        return ""
    text = str(value)
    text = text.replace("&", "&amp;")
    text = text.replace("<", "&lt;").replace(">", "&gt;")
    text = text.replace("[", "&#91;").replace("]", "&#93;").replace("`", "&#96;")
    return text


def _safe_url(url):
    if not isinstance(url, str):
        return None
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return None
    return (
        url.replace(" ", "%20")
        .replace("(", "%28")
        .replace(")", "%29")
        .replace("<", "%3C")
        .replace(">", "%3E")
    )


def _link(label, url):
    safe = _safe_url(url)
    if safe is None:
        return _escape_text(label)
    return f"[{_escape_text(label)}]({safe})"


def _cell(value):
    return _escape_text(value).replace("|", "\\|").replace("\n", " ")


def render_json(view):
    return json.dumps(view, ensure_ascii=False, indent=2, sort_keys=True)


def _join_ids(values):
    return "、".join(str(v) for v in values or [])


def render_markdown(view):
    """Render the filtered snapshot. The renderer is pure: it does not change
    stored state and does not invoke any provider. JSON and Markdown present the
    same claims (support and refute), events (action and outcome), hypotheses
    (support, counter, alternatives, falsifier) and uncertainty."""

    lines = []
    lines.append(f"# 证据门禁探针报告 · {_escape_text(view.get('run_id'))}")
    lines.append("")
    lines.append(
        "> 合成离线探针输出；audience="
        + _escape_text(view.get("audience", "internal"))
        + "；不调用网络、模型或 provider。"
    )
    lines.append("")
    lines.append(
        f"`{_escape_text(view.get('run_id'))}` · revision {view.get('revision')} · "
        f"{_escape_text(view.get('state'))} · 截至 {_escape_text(view.get('as_of'))}"
    )
    lines.append("")

    lines.append("## 结构元数据")
    lines.append(f"- revision: {view.get('revision')}（supersedes: {view.get('supersedes')}）")
    lines.append(f"- as_of: {_escape_text(view.get('as_of'))}")
    if "usage" in view:
        usage = view.get("usage") or {}
        lines.append(
            f"- usage: requests={usage.get('requests')} cost_usd={usage.get('cost_usd')} "
            f"measurement={_escape_text(usage.get('measurement_status'))}"
        )
    if "stop_reason" in view:
        lines.append(f"- stop_reason: {_escape_text(view.get('stop_reason'))}")
    lines.append("")

    lines.append("## 人物索引")
    if not view.get("people_index"):
        lines.append("- （无）")
    for person in view.get("people_index", []):
        anchor = _anchor(person.get("report_anchor"))
        parts = [
            f"[{_escape_text(person.get('display_name'))}](#{anchor})",
            f"`{_escape_text(person.get('person_id'))}`",
            f"身份 {_escape_text(person.get('identity_status'))}",
        ]
        for profile in person.get("profile_links", []):
            parts.append(_link(profile.get("url"), profile.get("url")))
        lines.append("- " + " · ".join(parts))
        lines.append(f"<a id=\"{anchor}\"></a>")
    lines.append("")

    lines.append("## 断言")
    lines.append("| claim_id | 人物 | 断言 | kind / status | support | refute | valid | as_of |")
    lines.append("|---|---|---|---|---|---|---|---|")
    if not view.get("claims"):
        lines.append("| （无） | - | - | - | - | - | - | - |")
    for claim in view.get("claims", []):
        valid_from = claim.get("valid_from") or "-"
        valid_to = claim.get("valid_to") or "-"
        lines.append(
            "| `{cid}` | `{pid}` | {statement} | {kind} / {status} | {support} | {refute} | "
            "{vfrom}..{vto} | {asof} |".format(
                cid=_cell(claim.get("claim_id")),
                pid=_cell(claim.get("person_id")),
                statement=_cell(claim.get("statement")),
                kind=_cell(claim.get("kind")),
                status=_cell(claim.get("status")),
                support=_cell(_join_ids(claim.get("support_evidence_ids"))),
                refute=_cell(_join_ids(claim.get("refute_evidence_ids"))),
                vfrom=_cell(valid_from),
                vto=_cell(valid_to),
                asof=_cell(claim.get("as_of")),
            )
        )
    lines.append("")

    lines.append("## 事件")
    if not view.get("events"):
        lines.append("- （无）")
    for event in view.get("events", []):
        action = _join_ids(event.get("action_claim_ids"))
        outcome = _join_ids(event.get("outcome_claim_ids"))
        parts = [
            f"`{_escape_text(event.get('event_id'))}`",
            f"`{_escape_text(event.get('person_id'))}`",
            f"recorded={_escape_text(event.get('recorded_at'))}",
            f"occurred={_escape_text(event.get('occurred_at'))}",
            f"action={_escape_text(action)}",
            f"outcome={_escape_text(outcome)}",
        ]
        if event.get("context"):
            parts.append(f"context={_escape_text(event.get('context'))}")
        lines.append("- " + " · ".join(parts))
        for unknown in event.get("unknowns", []):
            text = unknown.get("text") if isinstance(unknown, dict) else unknown
            lines.append(f"  - 事件未知：{_escape_text(text)}")
    lines.append("")

    lines.append("## 行为假设")
    if not view.get("behavior_hypotheses"):
        lines.append("- （无）")
    for hypothesis in view.get("behavior_hypotheses", []):
        support = _join_ids(hypothesis.get("support_event_ids"))
        counter = _join_ids(hypothesis.get("counter_event_ids"))
        parts = [
            f"`{_escape_text(hypothesis.get('hypothesis_id'))}`",
            _escape_text(hypothesis.get("statement")),
            f"support={_escape_text(support)}",
            f"counter={_escape_text(counter)}",
            f"status={_escape_text(hypothesis.get('status'))}",
        ]
        if hypothesis.get("alternatives"):
            parts.append(f"alternatives={_escape_text(_join_ids(hypothesis.get('alternatives')))}")
        if hypothesis.get("falsifier"):
            parts.append(f"falsifier={_escape_text(hypothesis.get('falsifier'))}")
        lines.append("- " + " · ".join(parts))
    lines.append("")

    lines.append("## 未知与覆盖")
    for entry in view.get("coverage", []):
        lines.append(
            f"- {_escape_text(entry.get('question'))}：{_escape_text(entry.get('status'))}"
            + (f"（{_escape_text(entry.get('reason'))}）" if entry.get("reason") else "")
            + (f" claims={_escape_text(_join_ids(entry.get('claim_ids')))}" if entry.get("claim_ids") else "")
        )
    for unknown in view.get("unknowns", []):
        if isinstance(unknown, str):
            lines.append(f"- {_escape_text(unknown)}")
        else:
            lines.append(f"- {_escape_text(unknown.get('text'))}")
    if not view.get("coverage") and not view.get("unknowns"):
        lines.append("- （无）")
    lines.append("")

    lines.append("## 来源")
    lines.append("| source_id | 标题 | canonical URL | policy |")
    lines.append("|---|---|---|---|")
    if not view.get("sources"):
        lines.append("| （无） | - | - | - |")
    for source in view.get("sources", []):
        url = source.get("canonical_url")
        lines.append(
            "| `{sid}` | {title} | {url} | {policy} |".format(
                sid=_cell(source.get("source_id")),
                title=_cell(source.get("title")),
                url=_link(url, url),
                policy=_cell(source.get("export_policy")),
            )
        )
    lines.append("")

    lines.append("## 证据摘录")
    for item in view.get("evidence", []):
        if item.get("withdrawn") or item.get("excerpt") is None:
            lines.append(
                f"- `{_escape_text(item.get('evidence_id'))}` · `{_escape_text(item.get('source_id'))}` · "
                f"{_escape_text(item.get('locator'))} —（已撤销，无可读摘录）"
            )
        else:
            lines.append(
                f"- `{_escape_text(item.get('evidence_id'))}` · `{_escape_text(item.get('source_id'))}` · "
                f"{_escape_text(item.get('locator'))} — “{_escape_text(item.get('excerpt'))}”"
            )
    if not view.get("evidence"):
        lines.append("- （无）")
    lines.append("")
    return "\n".join(lines)


_VALID_AUDIENCES = ("internal", "public")
_VALID_FORMATS = ("json", "markdown")


def export_report(store, run_id, revision=None, fmt="json", audience="internal"):
    """Read and export one report revision, returning an explicit envelope.

    Audience and format are validated against closed enums before any data
    access; an unknown audience is never silently treated as internal. A
    superseded revision returns ``revision_superseded`` instead of exporting
    stale content. Rendering is pure and never calls a provider.
    """

    if audience not in _VALID_AUDIENCES:
        return {"ok": False, "errors": [{"code": "invalid_audience", "audience": audience}]}
    if fmt not in _VALID_FORMATS:
        return {"ok": False, "errors": [{"code": "invalid_format", "format": fmt}]}

    try:
        snapshot = (
            store.read_revision(run_id, revision)
            if revision is not None
            else store.read_current(run_id)
        )
    except RevisionSuperseded as exc:
        return {
            "ok": False,
            "errors": [
                {
                    "code": exc.code,
                    "run_id": exc.run_id,
                    "revision": exc.revision,
                    "superseded_by": exc.superseded_by,
                }
            ],
        }
    except ReportNotFound as exc:
        return {
            "ok": False,
            "errors": [{"code": exc.code, "run_id": exc.run_id, "revision": exc.revision}],
        }

    try:
        view = (
            build_public_view(snapshot) if audience == "public" else build_internal_view(snapshot)
        )
    except GateError as exc:
        return {"ok": False, "errors": [{"code": exc.code, "message": exc.message}]}
    content = render_json(view) if fmt == "json" else render_markdown(view)
    return {
        "ok": True,
        "audience": audience,
        "format": fmt,
        "revision": view.get("revision"),
        "content": content,
        "view": view,
    }


def scan_for_private_material(text):
    """Return any forbidden substrings found in an artifact string."""

    return [pattern for pattern in PRIVATE_PATTERNS if pattern in text]

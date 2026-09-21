# Evidence-gate decision probe (disposable, offline)

> Status: synthetic / discovery / unreviewed. This is a decision probe, **not a
> production research agent**. Inputs are explicitly authored synthetic
> annotations, **not an NLP extractor**. No network, model or provider call is
> made. The repository's 12 existing discovery cases were **not** run here.

## Question

On an explicitly annotated synthetic identity/evidence graph, can a single
canonical report plus a revision/export gate invalidate identity/evidence
dependencies while preserving unaffected facts in both JSON and Markdown?

This is not "can a model research a person". It does not measure extraction,
semantic entailment, retrieval quality, real precision, or user benefit.

## Decision (recording rules)

- `automated_verdict: supported` — every declared synthetic check and fatal
  gate passed (`134/134` checks across `23/23` cases, artifact scan clean,
  zero forbidden calls). Derived only from behavior assertions. This includes the
  legal source-withdrawal branch; no branch is left inconclusive.
- `human_choice: unreviewed` — an automated pass does not promote any sample to
  human gold. A human reviewer must still decide.
- `ai_hypothesis` — the gate design may transfer to a real collection pipeline;
  the probe only studies dependency invalidation on authored synthetic inputs.
- `observed_facts` — the concrete behaviors listed below.

## What the probe does

- Stores immutable canonical snapshots with `current`/`superseded` revision
  status in SQLite (`sqlite3`, transactional writes, payload immutability
  trigger). A malformed revision fails before or inside a transaction and never
  supersedes a valid report.
- Reads a superseded revision (including after reconnect) as an explicit
  `revision_superseded` error with `superseded_by`; export refuses stale content.
- Distinguishes a failed live retrieval from a legal local withdrawal. A live
  page becoming unreachable does **not** invalidate a saved/readable historical
  snapshot body. `apply_source_withdrawal(snapshot, source_id)` explicitly marks
  a source (and its evidence) inert, removes the usable body/excerpt, recomputes
  dependent links/claims/events/hypotheses/coverage/profiles, validates the new
  revision, and atomically stores it so the old revision becomes
  `revision_superseded` (also after reopen). Internal and public views never
  emit the withdrawn excerpt or its conclusions; inert audit records and
  references are retained. This is logical withdrawal, not secure erasure.
  Inert evidence is accepted only when bound to a withdrawn source, never keeps
  an excerpt, and may not be referenced by an active claim, so an inconsistent
  input cannot bypass validation by marking itself inert.
- Validates unique IDs and every foreign key, including people/profile identity
  evidence, identity-link basis evidence, claim evidence, event claim edges and
  hypothesis event edges; claim person correspondence; readable source status;
  exact excerpt presence in the synthetic body; a known permission enum (unknown
  fails closed).
- Accepts support only through an eligible identity link. `rejected`,
  `candidate` and `disputed` links are ineligible and never re-enter the
  eligibility fixpoint. Eligibility is the least fixpoint from *seeds* whose
  basis is entirely self-source; a self-source excerpt is a support record but
  cannot waive any declared cross-source dependency. Cross-source cycles with
  no independent seed are rejected. Identity is never inferred from a matching
  name.
- Revokes identity links and conservatively invalidates dependent claims,
  events, hypotheses, answered coverage and verified profiles, propagating
  across cross-source basis dependencies while preserving unrelated branches.
- Recomputes public identity eligibility on the public-permitted subgraph to a
  fixed point, so a public source that leans on a restricted cross-source basis
  (any number of hops) is excluded, with no dangling identity or evidence
  pointers. Public export recomputes or conservatively omits every
  restricted-dependent node: restricted source metadata, excerpts, evidence,
  claims, events, hypotheses, people-index entries, profiles and derived
  narrative. Mixed public/private support is excluded instead of claiming
  independent support. Unknown policy fails closed.
- Requires explicit provenance for text-bearing fields: each narrative field
  carries a `*_provenance` list of claim IDs (display names reference evidence
  IDs). A field is public only when its declared provenance is non-empty and
  entirely public; missing, mixed or restricted provenance is omitted rather
  than trusted. Claims use their support/refute annotations, and source
  excerpts use their source policy. This is a declared-permission check, not a
  semantic entailment check. Only typed structural metadata is public; free-text
  metadata such as `stop_reason`/`usage` stays internal.
- Renders JSON and Markdown from the same filtered snapshot, preserving
  claim/evidence IDs, statuses, `as_of`, revision, people anchors, canonical
  URLs, support **and** refute evidence, claim validity windows, event outcomes
  and unknowns, hypothesis counter events/alternatives/falsifier, and
  uncertainty; HTML and unsafe link schemes are escaped. Rendering is pure and
  does not change stored state.

## Case coverage

`cases.py` independently exercises: valid unaffected branch (positive coverage);
same-name unlinked source; rejected/candidate/disputed link states (including a
rejected cross-source regression); inaccessible source with an attempted quote;
forged excerpt; broken references, duplicate IDs, unknown policy and claim
status/kind/revision enums; leaf identity revocation through event + hypothesis +
coverage; cross-source identity basis revocation; mixed self+cross basis that
still requires the cross dependency; identity-cycle rejection, a mixed-basis
cycle, and a pure self-anchor chain control; superseded revision read/export
after reopen and malformed-revision non-supersession; legal source withdrawal
with old-export rejection after reopen and an untouched public branch; live
inaccessible page with a retained snapshot; inconsistent inert-evidence
rejection; private-only coverage not leaking after revocation; public/private
mixed support and private-only person/profile; public permission fixed point over
a three-hop chain; explicit public provenance controls (positive, missing,
mixed); audience/format enum validation; renderer parity and escaping; and
per-node material fields in Markdown. Failing inputs are expected rejections, not
case-execution failures.

## Honest limitations and remaining uncertainty

- The forbidden-call guard is an **in-process Python monkeypatch** of stdlib
  `socket`/`urllib` entry points. It is not an OS sandbox: it cannot prove that
  subprocesses, C extensions, or references cached before the guard are silent.
- Declared provenance is authored input, not semantic truth. The probe checks
  that referenced claim/evidence nodes are public and reachable; it does not and
  cannot verify that free text follows from them. Text with no declared
  provenance is omitted, so absence of provenance never grants access.
- Only authored synthetic dependency shapes are covered; they do not represent a
  real report dependency distribution.
- Source withdrawal is a logical transition over the synthetic snapshot: it
  removes the usable body/excerpt and invalidates dependents, but it is not a
  claim of secure or physical erasure of the stored SQLite history. Production
  physical deletion remains out of scope.
- No benchmark, semantic validation, precision claim, model evaluation, or
  provider/adapter was added. No real collection was run.

## Run

The payload uses the probe-only `stripsearch/evidence-gate-probe-v1` schema,
including explicit text provenance and withdrawal markers. It is not the
published v0.1 envelope, a production migration, or a drop-in runtime.
The independent `test_review_regressions.py` adds four review counterexamples
(revoked display name, dangling person links, stale revision parent, and source withdrawal reference integrity). The final
local suite contains 33 tests; the CLI separately runs 23 cases / 134 checks.
Recorded outputs are in [results/report.md](results/report.md) and
[results/receipt.json](results/receipt.json). These remain discovery/unreviewed.

```bash
python3 -m unittest discover -s probes/evidence_gate -p 'test_*.py' -v
python3 probes/evidence_gate/run.py --output <directory>
```

The CLI accepts a caller output directory, writes a small `receipt.json`
(internal synthetic diagnostic) and `report.md` (this decision receipt plus a
public-export sample), auto-cleans temporary SQLite databases, and exits nonzero
if any declared check or fatal gate fails (case failure, forbidden-call
observation, or artifact private-material scan). Observed facts are derived from
actual case outcomes, never from a hardcoded success list. If the artifact scan
matches, free-text diagnostic content is replaced by marker names before
anything is written. Artifact paths and logs contain no private paths, Notion
URLs or credentials.

## Files

- `core.py` — importable core: synthetic model, fail-closed gate, link
  eligibility fixpoint (full and public subgraphs), revocation, SQLite revision
  store, public/internal views with provenance checks, pure JSON/Markdown
  renderers, in-process network guard.
- `fixtures.py` — original synthetic fixtures: base, mixed-basis, permission
  chain, counterevidence, provenance controls, cycle/anchored chain, hostile.- `cases.py` — deterministic cases with before/after traces and declared checks.
- `run.py` — CLI runner and decision receipt writer.
- `test_evidence_gate.py` — meaningful unittest suite (behavior assertions).
- `README.md` — this decision receipt.

Official API references (source is the official Python documentation):

- `sqlite3`: <https://docs.python.org/3.12/library/sqlite3.html>
- `unittest`: <https://docs.python.org/3.12/library/unittest.html>

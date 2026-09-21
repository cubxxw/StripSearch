#!/usr/bin/env python3
"""Offline integrity checks for the authored datasets; this does not grade answers."""
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def require(condition, message):
    if not condition:
        raise ValueError(message)


def rows(relative):
    records = [json.loads(line) for line in (ROOT / relative).read_text().splitlines() if line.strip()]
    require(bool(records), f'{relative}: empty dataset')
    ids = [row['case_id'] for row in records]
    require(len(ids) == len(set(ids)), f'{relative}: duplicate case ID')
    return records


def check():
    runtime = rows('evals/runtime-v1/cases.jsonl')
    families = {}
    for case in runtime:
        require(case['dataset_version'] == 'runtime-v1', 'Runtime version mismatch')
        require(case['review_status'] == 'unreviewed', 'Runtime spec must not silently become gold')
        require(case['split'] in ('discovery', 'regression'), 'Invalid public split')
        families.setdefault(case['family'], set()).add(case['split'])
        require(case['expect']['requests'] == len(case['replay']), f"{case['case_id']}: request/replay count mismatch")
    require(all(len(splits) == 1 for splits in families.values()), 'Family leaks across splits')
    require(all(sum(c['family'] == family for c in runtime) == 2 for family in families), 'Each minimal-pair family needs both cases')

    behavior = rows('evals/behavior-v1/cases.jsonl')
    fixture = json.loads((ROOT / 'evals/behavior-v1/fixtures.json').read_text())
    require(fixture['dataset_version'] == 'behavior-v1', 'Behavior fixture version mismatch')
    require(fixture['network_access'] is False, 'Behavior fixtures must be offline')
    sources = {s['source_id']: s for s in fixture['sources']}
    require(len(sources) == len(fixture['sources']), 'Duplicate behavior source')
    for source in sources.values():
        require(source['source'] == 'synthetic' and source['redistribution'] == 'Apache-2.0-original-synthetic', 'Behavior source attribution lost')
        require(hashlib.sha256(source['body'].encode()).hexdigest() == source['body_sha256'], 'Behavior source hash mismatch')
    for case in behavior:
        require(case['dataset_version'] == 'behavior-v1' and case['split'] == 'discovery', 'Behavior version/split mismatch')
        require(case['review_status'] == 'unreviewed' and case['execution_status'] == 'not_run', 'Behavior state must reflect no human/model evaluation')
        refs = set(case['available_source_ids'])
        require(bool(refs) and refs <= sources.keys(), f"{case['case_id']}: missing sources")
        require(all(sources[s]['entity_group'] == case['entity_group'] for s in refs), 'Behavior entity mismatch')
        require(bool(case['required_assertions']) and bool(case['forbidden_assertions']), 'Rubric needs coverage and limits')
        require(bool(case['rubric']), 'Behavior rubric must not be empty')
        require(len({r['criterion_id'] for r in case['rubric']}) == len(case['rubric']), 'Duplicate rubric criterion')
        require(all(bool(r['source_ids']) and set(r['source_ids']) <= refs and math.isfinite(r['weight']) and r['weight'] > 0 for r in case['rubric']), 'Invalid rubric evidence')

    frames = rows('evals/external/frames-v1/cases.jsonl')
    manifest = json.loads((ROOT / 'evals/external/frames-v1/manifest.json').read_text())
    content = (ROOT / 'evals/external/frames-v1/cases.jsonl').read_bytes()
    require(hashlib.sha256(content).hexdigest() == manifest['subset_sha256'], 'FRAMES subset hash mismatch')
    require([c['upstream_id'] for c in frames] == manifest['selected_ids'], 'FRAMES selection drift')
    require(len(frames) == manifest['selected_rows'], 'FRAMES count mismatch')
    for case in frames:
        require(case['dataset_version'] == 'frames-discovery-v1' and case['review_status'] == 'upstream_reference_unreviewed_locally', 'FRAMES version/review status mismatch')
        require(case['upstream_revision'] == manifest['source_revision'], 'FRAMES revision mismatch')
        require(case['license'] == 'Apache-2.0', 'FRAMES attribution lost')
        require(case['execution_status'] == 'not_run' and case['split'] == 'discovery', 'FRAMES must not claim execution or unseen holdout')
        require(case['input']['prompt'] and case['reference_answer'] and case['evidence_urls'], 'Empty FRAMES record')
    print(f'PASS: {len(runtime)} runtime specs, {len(behavior)} behavior specs/{len(sources)} sources, {len(frames)} FRAMES records. Integrity only; no model evaluation.')

if __name__ == '__main__':
    check()

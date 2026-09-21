#!/usr/bin/env python3
"""Rebuild the small FRAMES discovery subset from a pinned, local TSV. No network."""
import argparse
import ast
import csv
import hashlib
import io
import json
from pathlib import Path

REVISION = '58d9fb6330f3ab1316d1eca12e5e8ef23dcc22ef'
SOURCE_SHA256 = '4255093c93b595b5b04c7c8dde290b48ec87d72ca0fb0b760d9dd02740d669ff'
SOURCE_URL = f'https://huggingface.co/datasets/google/frames-benchmark/resolve/{REVISION}/test.tsv'
SELECTED_IDS = [1, 2, 3, 4, 6, 8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 22, 26, 32, 38, 40, 43, 46, 47, 59]
ROOT = Path(__file__).resolve().parent.parent


def convert(content):
    if hashlib.sha256(content).hexdigest() != SOURCE_SHA256:
        raise ValueError('Source checksum does not match the pinned FRAMES revision')
    rows = list(csv.DictReader(io.StringIO(content.decode('utf-8')), delimiter='\t'))
    if len(rows) != 824:
        raise ValueError('Unexpected source row count')
    indexed = {int(row['']): row for row in rows}
    if len(indexed) != len(rows):
        raise ValueError('Duplicate upstream IDs')
    selected = []
    for ident in SELECTED_IDS:
        row = indexed[ident]
        links = ast.literal_eval(row['wiki_links'])
        if not isinstance(links, list) or not links or not all(isinstance(x, str) and x.startswith('https://en.wikipedia.org/wiki/') for x in links):
            raise ValueError(f'Invalid evidence links at upstream ID {ident}')
        if not row['Prompt'].strip() or not row['Answer'].strip():
            raise ValueError(f'Empty question or reference at {ident}')
        selected.append({
            'case_id': f'frames-{ident:03d}', 'dataset_version': 'frames-discovery-v1',
            'source': 'google/frames-benchmark', 'upstream_id': ident, 'upstream_revision': REVISION,
            'split': 'discovery', 'upstream_split': 'test', 'license': 'Apache-2.0',
            'review_status': 'upstream_reference_unreviewed_locally', 'execution_status': 'not_run',
            'input': {'prompt': row['Prompt']}, 'reference_answer': row['Answer'],
            'evidence_urls': links, 'reasoning_types': [x.strip() for x in row['reasoning_types'].split('|')],
            'local_changes': 'Schema conversion and selection only; question and reference answer unchanged.'
        })
    return selected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path, help=f'Local TSV downloaded from {SOURCE_URL}')
    parser.add_argument('--output', type=Path, default=ROOT / 'evals/external/frames-v1')
    args = parser.parse_args()
    cases = convert(args.source.read_bytes())
    args.output.mkdir(parents=True, exist_ok=True)
    serialized = ''.join(json.dumps(case, ensure_ascii=False, separators=(',', ':')) + '\n' for case in cases)
    (args.output / 'cases.jsonl').write_text(serialized, encoding='utf-8')
    manifest = {
        'dataset_version': 'frames-discovery-v1', 'source_url': SOURCE_URL, 'source_revision': REVISION,
        'source_sha256': SOURCE_SHA256, 'source_rows': 824, 'selected_ids': SELECTED_IDS,
        'selected_rows': len(cases), 'subset_sha256': hashlib.sha256(serialized.encode()).hexdigest(),
        'selection': 'Pre-run exploratory selection across numerical, temporal, tabular and multi-constraint questions; not representative sampling.',
        'frozen_web_corpus': False, 'source_articles_downloaded': False, 'model_runs': 0,
        'license_url': f'https://huggingface.co/datasets/google/frames-benchmark/blob/{REVISION}/README.md'
    }
    (args.output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Prepared {len(cases)} FRAMES cases; model runs: 0; source articles fetched: 0')

if __name__ == '__main__':
    main()

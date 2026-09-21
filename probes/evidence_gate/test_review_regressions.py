"""Independent review counterexamples; synthetic, discovery, unreviewed."""
import copy
import unittest

import core
import fixtures


class ReviewRegressions(unittest.TestCase):
    def test_withdrawal_of_each_source_preserves_public_reference_integrity(self):
        original = fixtures.base_snapshot()
        for source in original['sources']:
            with self.subTest(source=source['source_id']):
                withdrawn = core.apply_source_withdrawal(original, source['source_id'])
                core.validate_snapshot(withdrawn)
                view = core.build_public_view(withdrawn)
                sources = {s['source_id'] for s in view['sources']}
                people = {p['person_id'] for p in view['people_index']}
                self.assertNotIn(source['source_id'], sources)
                for link in view['identity_links']:
                    self.assertIn(link['source_id'], sources)
                    self.assertIn(link['person_id'], people)
                self.assertTrue(all(e['source_id'] in sources for e in view['evidence']))

    def test_display_name_loses_revoked_identity_basis(self):
        snapshot = fixtures.base_snapshot()
        person = next(p for p in snapshot['people_index'] if p['person_id'] == 'person-lz')
        person['display_name'] = 'REVOKED_NAME_SENTINEL'
        person['display_name_provenance'] = ['ev-cross']
        revised = core.apply_identity_revocation(snapshot, 'person-lz', 's-news')
        self.assertFalse(core.link_eligibility(revised)[('person-lz', 's-cross')][0])
        view = core.build_public_view(revised)
        self.assertNotIn('REVOKED_NAME_SENTINEL', core.render_json(view))
        self.assertNotIn('REVOKED_NAME_SENTINEL', core.render_markdown(view))

    def test_omitted_person_leaves_no_links_or_unreachable_sources(self):
        snapshot = fixtures.base_snapshot()
        person = next(p for p in snapshot['people_index'] if p['person_id'] == 'person-lz')
        person.pop('display_name_provenance')
        view = core.build_public_view(snapshot)
        people = {p['person_id'] for p in view['people_index']}
        self.assertNotIn('person-lz', people)
        self.assertTrue(all(link['person_id'] in people for link in view['identity_links']))
        self.assertEqual(view['evidence'], [])
        self.assertEqual(view['sources'], [])

    def test_revision_cannot_claim_wrong_parent(self):
        store = core.SnapshotStore()
        try:
            first = fixtures.base_snapshot()
            store.add_revision(first)
            second = core.apply_identity_revocation(first, 'person-lz', 's-news')
            store.add_revision(second)
            stale = copy.deepcopy(second)
            stale['revision'] = 3
            stale['supersedes'] = 1
            with self.assertRaises(core.GateError) as raised:
                store.add_revision(stale)
            self.assertEqual(raised.exception.code, 'stale_revision')
            self.assertEqual(store.read_current(first['run_id'])['revision'], 2)
        finally:
            store.close()


if __name__ == '__main__':
    unittest.main()

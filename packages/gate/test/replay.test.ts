import { describe, expect, test } from 'bun:test';
import { npmVersionEvidence } from '../src/npm/evidence';
import { decide } from '../src/policy';
import { loadSupplyChainPolicyV1 } from './support/policies';
import { loadReplayFixtures } from './replay/fixture';

const policy = loadSupplyChainPolicyV1();

for (const { name, fixture } of loadReplayFixtures()) {
  const { target, takedownAt } = fixture;

  describe(name, () => {
    for (const { at, moment, expected } of fixture.evaluations) {
      test(moment, () => {
        expect(at.getTime()).toBeGreaterThanOrEqual(target.time.getTime());
        if (takedownAt !== null) {
          expect(at.getTime()).toBeLessThan(takedownAt.getTime());
          if (fixture.miss === undefined) {
            expect(expected.outcome).not.toBe('ACCEPT');
          }
        }

        const evidence = npmVersionEvidence({
          name: fixture.package,
          registry: 'https://registry.npmjs.org',
          target,
          earlier: fixture.earlier,
          feeds: {
            kind: 'checked',
            hits: fixture.feedHits
              .filter((hit) => hit.availableAt <= at)
              .map(({ feed, id }) => ({ feed, id })),
          },
          claims: [],
        });
        const decision = decide({
          evidence,
          now: at,
          context: { allowedSources: [], waivers: [] },
          canonical: policy,
        });

        expect({
          outcome: decision.outcome,
          reasons: decision.reasons.map((reason) => reason.code).toSorted(),
        }).toEqual({
          outcome: expected.outcome,
          reasons: expected.reasons.toSorted(),
        });
      });
    }
  });
}

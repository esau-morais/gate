import { describe, expect, test } from 'bun:test';
import { Schema } from 'effect';
import { Sha512Integrity } from '../src/evidence';
import {
  certificateWorkflow,
  type ProvenanceResult,
  trustMaterialFrom,
  verifyNpmProvenance,
} from '../src/npm/provenance';
import { recordedEvidence } from './verify/cases';

const trustedRoot = recordedEvidence('trusted_root.json');
const trust = trustMaterialFrom(trustedRoot);
const attestations = recordedEvidence('attestations/vite@8.3.0.json');
const integrity = Schema.decodeUnknownSync(Sha512Integrity)(
  'sha512-lhZBVvEHefgE+HQZC9O7EBJgCU/nVzFNl7vkS4RE0APtWLP02/8QVIkQtzBxPquh7lq5/78NHipTj7ODQ6XuyQ==',
);
const otherIntegrity = Schema.decodeUnknownSync(Sha512Integrity)(
  'sha512-cFKLV/PRgAUlIRm5WjMjJ86jrftzpqcgH+Us+DS8mI3CDNiH30Whrz8uHL3+MOLPAgqbMBAqWdAHAphOAM+z/Q==',
);
const vite = { name: 'vite', version: '8.3.0', integrity };

const decodeIntegrity = Schema.decodeUnknownSync(Sha512Integrity);
const provenanceDir = new URL('./provenance/', import.meta.url);
const recorded = (file: string) => recordedEvidence(file, provenanceDir);
const semver = [
  {
    version: '7.5.1',
    integrity:
      'sha512-Wvss5ivl8TMRZXXESstBA4uR5iXgEN/VC5/sOcuXdVLzcdkz4HWetIoRfG5gb5X+ij/G9rw9YoGn3QoQ8OCSpw==',
  },
  {
    version: '7.5.2',
    integrity:
      'sha512-SoftuTROv/cRjCze/scjGyiDtcUyxw1rgYQSZY7XTmtR5hX+dm76iDbTH8TkLPHCQmlbQVSSbNZCPM2hb0knnQ==',
  },
  {
    version: '7.5.3',
    integrity:
      'sha512-QBlUtyVk/5EeHbi7X0fw6liDZc7BBmEaSYn01fMU1OUYbf6GPsbTtd8WmnqbI20SeycoHSeiybkE/q1Q+qlThQ==',
  },
].map(({ version, integrity }) => ({
  subject: { name: 'semver', version, integrity: decodeIntegrity(integrity) },
  attestations: recorded(`semver@${version}.json`),
}));
const canonicalJson = [
  {
    version: '1.0.0',
    integrity:
      'sha512-QTnf++uxunWvG2z3UFNzAoQPHxnSXOwtaI3iJ+AohhV+5vONuArPjJE7aPXPVXfXJsqrVbZBu9b81AJoSd09IQ==',
  },
  {
    version: '2.0.0',
    integrity:
      'sha512-yVtV8zsdo8qFHe+/3kw81dSLyF7D576A5cCFCi4X7B39tWT7SekaEFUnvnWJHz+9qO7qJTah1JbrDjWKqFtdWA==',
  },
].map(({ version, integrity }) => ({
  subject: {
    name: '@tufjs/canonical-json',
    version,
    integrity: decodeIntegrity(integrity),
  },
  attestations: recorded(`tufjs-canonical-json@${version}.json`),
}));
const appsemble = {
  subject: {
    name: 'appsemble',
    version: '0.23.0',
    integrity: decodeIntegrity(
      'sha512-iZlVB/qGQSDLOxqRVVF2eJZTV1QapZc+y+qPbECn3kJc0Fqom2IAfEIoxXmke/MJ+qfuN/YI/MtAvHUD6W+57Q==',
    ),
  },
  attestations: recorded('appsemble@0.23.0.json'),
};
const workflowRepositoryOid = [1, 3, 6, 1, 4, 1, 57264, 1, 5];

const slsa = 'https://slsa.dev/provenance/v1';

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(value: unknown): Json {
  if (!isJson(value)) {
    throw new Error('recorded JSON has an unexpected shape');
  }

  return value;
}

function entries(response: unknown): readonly unknown[] {
  const list: unknown = object(response).attestations;
  if (!Array.isArray(list)) {
    throw new Error('recorded response has no attestations');
  }

  return list;
}

function isProvenance(entry: unknown): boolean {
  return isJson(entry) && entry.predicateType === slsa;
}

describe('npm provenance', () => {
  test('a recorded bundle verifies offline and names the publishing workflow', () => {
    expect(verifyNpmProvenance({ trust, attestations, ...vite })).toEqual({
      kind: 'verified',
      repository: 'https://github.com/vitejs/vite',
      workflow: '.github/workflows/publish.yml',
    });
  });

  test('a valid bundle for another version or tarball is not this version’s provenance', () => {
    for (const subject of [
      { ...vite, version: '8.2.2' },
      { ...vite, name: 'vite-fork' },
      { ...vite, integrity: otherIntegrity },
    ]) {
      const result = verifyNpmProvenance({ trust, attestations, ...subject });

      expect(result.kind === 'unavailable' && result.reason).toStartWith(
        'signed subject is not',
      );
    }
  });

  test('a statement altered after signing fails', () => {
    const response = object(structuredClone(attestations));
    const entry = object(entries(response).find(isProvenance));
    const envelope = object(object(entry.bundle).dsseEnvelope);
    const payload = envelope.payload;
    if (typeof payload !== 'string') {
      throw new Error('recorded envelope has no payload');
    }

    envelope.payload = Buffer.from(
      Buffer.from(payload, 'base64')
        .toString('utf8')
        .replace('pkg:npm/vite@8.3.0', 'pkg:npm/vite@8.3.1'),
    ).toString('base64');

    expect(
      verifyNpmProvenance({
        trust,
        attestations: { attestations: [entry] },
        ...vite,
        version: '8.3.1',
      }),
    ).toMatchObject({ kind: 'unavailable' });
  });

  test('a trusted root without the signing CA verifies nothing', () => {
    const root = object(structuredClone(trustedRoot));
    root.certificateAuthorities = [];

    expect(
      verifyNpmProvenance({
        trust: trustMaterialFrom(root),
        attestations,
        ...vite,
      }).kind,
    ).toBe('unavailable');
  });

  test('a response without a SLSA provenance bundle is unavailable', () => {
    const publishOnly = {
      attestations: entries(attestations).filter(
        (entry) => !isProvenance(entry),
      ),
    };

    for (const response of [publishOnly, {}, 'not json', null]) {
      expect(
        verifyNpmProvenance({ trust, attestations: response, ...vite }).kind,
      ).toBe('unavailable');
    }
  });

  test('SLSA v0.2 bundles verify and name the workflow from the certificate', () => {
    for (const { subject, attestations } of semver) {
      expect(verifyNpmProvenance({ trust, attestations, ...subject })).toEqual({
        kind: 'verified',
        repository: 'https://github.com/npm/node-semver',
        workflow: '.github/workflows/release.yml',
      });
    }
  });

  test('a certificate without source repository and build config extensions names the workflow from its SAN URI', () => {
    const tufJs: ProvenanceResult = {
      kind: 'verified',
      repository: 'https://github.com/theupdateframework/tuf-js',
      workflow: '.github/workflows/release.yml',
    };

    for (const { subject, attestations } of canonicalJson) {
      expect(verifyNpmProvenance({ trust, attestations, ...subject })).toEqual(
        tufJs,
      );
    }
  });

  test('a valid v0.2 bundle for another package, version or tarball is not this version’s provenance', () => {
    const [first, second] = semver;
    const [legacy] = canonicalJson;
    if (first === undefined || second === undefined || legacy === undefined) {
      throw new Error('recorded bundles are missing');
    }

    for (const { subject, attestations } of [
      { ...first, subject: { ...first.subject, version: '7.5.2' } },
      { ...first, subject: { ...first.subject, name: 'semver-fork' } },
      { ...first, subject: second.subject },
      { ...legacy, subject: { ...legacy.subject, integrity: otherIntegrity } },
      { ...legacy, subject: { ...legacy.subject, version: '1.0.1' } },
    ]) {
      const result = verifyNpmProvenance({ trust, attestations, ...subject });

      expect(result.kind === 'unavailable' && result.reason).toStartWith(
        'signed subject is not',
      );
    }
  });

  test('a v0.2 bundle from a non-GitHub issuer is unavailable', () => {
    const result = verifyNpmProvenance({
      trust,
      attestations: appsemble.attestations,
      ...appsemble.subject,
    });

    expect(result.kind === 'unavailable' && result.reason).toStartWith(
      'verification failed',
    );
  });

  test('a SAN URI outside the certificate’s GitHub repository names no workflow', () => {
    for (const subjectAlternativeName of [
      'https://github.com/acme/shared/.github/workflows/publish.yml@refs/heads/main',
      'https://gitlab.com/acme/lib//.gitlab-ci.yml@refs/heads/main',
      'https://github.com/acme/lib.github/workflows/publish.yml@refs/heads/main',
    ]) {
      expect(
        certificateWorkflow({
          subjectAlternativeName,
          oids: [
            {
              oid: { id: workflowRepositoryOid },
              value: Buffer.from('acme/lib'),
            },
          ],
        }).kind,
      ).toBe('unavailable');
    }
  });
});

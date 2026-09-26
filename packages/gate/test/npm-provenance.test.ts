import { describe, expect, test } from 'bun:test';
import { Schema } from 'effect';
import { Sha512Integrity } from '../src/evidence';
import { trustMaterialFrom, verifyNpmProvenance } from '../src/npm/provenance';
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
});

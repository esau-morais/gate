import { bundleFromJSON } from '@sigstore/bundle';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import {
  toSignedEntity,
  toTrustMaterial,
  Verifier,
  type Signer,
  type TrustMaterial,
} from '@sigstore/verify';
import { Result, Schema } from 'effect';
import type { Sha512Integrity } from '../evidence';

export type TrustRoot =
  | { readonly kind: 'loaded'; readonly material: TrustMaterial }
  | { readonly kind: 'unavailable'; readonly reason: string };

export type ProvenanceResult =
  | {
      readonly kind: 'verified';
      readonly repository: string;
      readonly workflow: string;
    }
  | { readonly kind: 'unavailable'; readonly reason: string };

const githubIssuer = 'https://token.actions.githubusercontent.com';
const githubUrl = 'https://github.com/';
const legacyRepositoryOid = '1.3.6.1.4.1.57264.1.5';
const sourceRepositoryOid = '1.3.6.1.4.1.57264.1.12';
const buildConfigOid = '1.3.6.1.4.1.57264.1.18';

const SlsaPredicateType = Schema.Literals([
  'https://slsa.dev/provenance/v1',
  'https://slsa.dev/provenance/v0.2',
]);
const isSlsaPredicateType = Schema.is(SlsaPredicateType);

const TrustedRootDocument = Schema.Struct({
  mediaType: Schema.String.check(
    Schema.isPattern(/^application\/vnd\.dev\.sigstore\.trustedroot/),
  ),
});

const AttestationsResponse = Schema.Struct({
  attestations: Schema.Array(
    Schema.Struct({ predicateType: Schema.String, bundle: Schema.Unknown }),
  ),
});

const Statement = Schema.fromJsonString(
  Schema.Struct({
    _type: Schema.Literals([
      'https://in-toto.io/Statement/v1',
      'https://in-toto.io/Statement/v0.1',
    ]),
    predicateType: SlsaPredicateType,
    subject: Schema.NonEmptyArray(
      Schema.Struct({
        name: Schema.String,
        digest: Schema.Struct({ sha512: Schema.optionalKey(Schema.String) }),
      }),
    ),
  }),
);

const decodeResponse = Schema.decodeUnknownResult(AttestationsResponse);
const decodeStatement = Schema.decodeUnknownResult(Statement);

export class TrustedRootError extends Error {
  override readonly name = 'TrustedRootError';
}

export function trustMaterialFrom(json: unknown): TrustMaterial {
  if (Result.isFailure(Schema.decodeUnknownResult(TrustedRootDocument)(json))) {
    throw new TrustedRootError('not a Sigstore trusted root');
  }

  return toTrustMaterial(TrustedRoot.fromJSON(json));
}

function npmPurl(name: string, version: string): string {
  return `pkg:npm/${name.replace(/^@/, '%40')}@${version}`;
}

function derUtf8String(value: Uint8Array): string | undefined {
  const [tag, first] = value;
  if (tag !== 0x0c || first === undefined) {
    return undefined;
  }

  let length = first;
  let offset = 2;
  if (first >= 0x80) {
    const size = first - 0x80;
    if (size < 1 || size > 2) {
      return undefined;
    }

    length = 0;
    for (const byte of value.subarray(2, 2 + size)) {
      length = length * 256 + byte;
    }

    offset += size;
  }

  return offset + length === value.length
    ? new TextDecoder('utf-8', { fatal: true }).decode(value.subarray(offset))
    : undefined;
}

type CertificateIdentity = Signer['identity'];

function extensionBytes(
  identity: CertificateIdentity,
  oid: string,
): Uint8Array | undefined {
  return identity?.oids?.find((pair) => pair.oid?.id.join('.') === oid)?.value;
}

function certificateValue(
  identity: CertificateIdentity,
  oid: string,
): string | undefined {
  const value = extensionBytes(identity, oid);

  return value === undefined ? undefined : derUtf8String(value);
}

function legacyRepository(identity: CertificateIdentity): string | undefined {
  const value = extensionBytes(identity, legacyRepositoryOid);
  const name = value === undefined ? '' : new TextDecoder().decode(value);

  return /^[\w.-]+\/[\w.-]+$/.test(name) ? `${githubUrl}${name}` : undefined;
}

export function certificateWorkflow(
  identity: CertificateIdentity,
): ProvenanceResult {
  let repository = certificateValue(identity, sourceRepositoryOid);
  let buildConfig = certificateValue(identity, buildConfigOid);
  if (repository === undefined && buildConfig === undefined) {
    repository = legacyRepository(identity);
    buildConfig = identity?.subjectAlternativeName;
  }

  const prefix = `${repository}/`;
  if (repository === undefined || buildConfig?.startsWith(prefix) !== true) {
    return {
      kind: 'unavailable',
      reason: 'certificate does not name a source repository and workflow',
    };
  }

  const at = buildConfig.indexOf('@', prefix.length);
  const workflow = buildConfig.slice(prefix.length, at);

  return at === -1 || workflow === ''
    ? { kind: 'unavailable', reason: `unreadable build config ${buildConfig}` }
    : { kind: 'verified', repository, workflow };
}

export function verifyNpmProvenance(input: {
  trust: TrustMaterial;
  attestations: unknown;
  name: string;
  version: string;
  integrity: Sha512Integrity;
}): ProvenanceResult {
  const unavailable = (reason: string): ProvenanceResult => ({
    kind: 'unavailable',
    reason,
  });
  const response = decodeResponse(input.attestations);
  if (Result.isFailure(response)) {
    return unavailable('attestations response is unreadable');
  }

  const bundles = response.success.attestations.filter((entry) =>
    isSlsaPredicateType(entry.predicateType),
  );
  const [entry, ...extra] = bundles;
  if (entry === undefined || extra.length > 0) {
    return unavailable(
      `expected one SLSA provenance bundle, found ${bundles.length}`,
    );
  }

  let signer: Signer;
  let payload: string;
  try {
    const bundle = bundleFromJSON(entry.bundle);
    if (
      bundle.content.$case !== 'dsseEnvelope' ||
      bundle.content.dsseEnvelope.payloadType !== 'application/vnd.in-toto+json'
    ) {
      return unavailable('bundle does not carry an in-toto statement');
    }

    payload = bundle.content.dsseEnvelope.payload.toString('utf8');
    signer = new Verifier(input.trust).verify(toSignedEntity(bundle), {
      extensions: { issuer: githubIssuer },
    });
  } catch (error) {
    return unavailable(`verification failed: ${String(error)}`);
  }

  const statement = decodeStatement(payload);
  if (Result.isFailure(statement)) {
    return unavailable('signed statement is not SLSA provenance');
  }

  const purl = npmPurl(input.name, input.version);
  const sha512 = Buffer.from(
    input.integrity.slice('sha512-'.length),
    'base64',
  ).toString('hex');
  const matches = statement.success.subject.some(
    (subject) => subject.name === purl && subject.digest.sha512 === sha512,
  );

  return matches
    ? certificateWorkflow(signer.identity)
    : unavailable(`signed subject is not ${purl} with this integrity`);
}

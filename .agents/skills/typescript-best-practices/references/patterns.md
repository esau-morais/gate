# TypeScript patterns for gate

These examples explain type design. They are not the final evidence or decision schema.

## Represent unavailable evidence

```ts
type ProvenanceEvidence =
  | { kind: 'verified'; repository: string; workflow: string; digest: Sha512 }
  | { kind: 'absent'; digest: Sha512 }
  | { kind: 'unavailable'; reason: string; digest: Sha512 };

function describeProvenance(evidence: ProvenanceEvidence): string {
  switch (evidence.kind) {
    case 'verified':
      return `${evidence.repository} via ${evidence.workflow}`;
    case 'absent':
      return 'No provenance published';
    case 'unavailable':
      return `Unknown: ${evidence.reason}`;
    default: {
      const exhaustive: never = evidence;
      return exhaustive;
    }
  }
}
```

A failed fetch is not the same as a package without provenance. Never fold `unavailable` into `absent` or `verified`. Parse the bundle before constructing this internal type.

## Keep array access honest

```ts
type NonEmpty<T> = readonly [T, ...T[]];

function first<T>(values: NonEmpty<T>): T {
  return values[0];
}

function atIndex<T>(values: readonly T[], index: number): T | undefined {
  return values[index];
}
```

A non-empty array guarantees index zero. It does not prove a calculated index is present.

## Validate a numeric invariant

```ts
type ReleaseAgeHours = number & { readonly __brand: 'ReleaseAgeHours' };

function parseReleaseAgeHours(input: unknown): ReleaseAgeHours {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) {
    throw new Error('Expected a finite non-negative release age');
  }
  return input as ReleaseAgeHours;
}
```

The assertion records a checked constraint. A plain `releaseAgeHours: number` field cannot rule out a negative age from a clock skew or a backdated `time` entry. Use the brand only when the invariant must cross function boundaries.

## Separate type checking from parsing

```ts
type VerifyOptions = { format: 'json'; timeoutMs: number };

const verifyOptions = {
  format: 'json',
  timeoutMs: 10_000,
} satisfies VerifyOptions;
```

The satisfies operator checks an authored object. It does not parse a packument, verify a registry response, or constrain timeoutMs to positive values. Use the existing schema library for structured external data. Do not add a library to reproduce an example.

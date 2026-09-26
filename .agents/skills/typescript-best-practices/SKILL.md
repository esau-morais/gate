---
name: typescript-best-practices
description: Apply whenever writing or reviewing TypeScript in gate, including the CLI, evidence adapters, policy evaluation, the log, client adapters, schemas, tests, and configuration.
---

# TypeScript practices

Read the implementation and existing types before adding a model.

1. Accept external payloads as unknown. Packuments, Sigstore bundles, OSV records, deps.dev responses, lockfiles and scanner output are all external. Parse once into a named domain type. Infer types from the existing runtime schema when available.
2. Represent exclusive states with a shared kind discriminant. Handle every variant. Keep distinct failures when recovery differs.
3. Use satisfies for authored configuration and as const for literal inference. Neither validates external data.
4. Avoid assertions that conceal missing validation. Allow a narrow assertion only where its claim is established and TypeScript cannot express it. Isolate it at the boundary. Do not use as unknown as T or unchecked non-null assertions to escape model problems.
5. Brand IDs when interchange would produce a plausible but wrong decision, such as a digest, a policy hash or a package spec. Prefer object arguments when positional values are easy to swap. Keep ordinary primitives elsewhere.
6. Use the simplest total signature. Return explicit absence or require validated non-empty input where needed. A non-empty array does not make every numeric index safe.
7. Validate numeric constraints. A number can be negative, non-finite, or outside the meaningful range.
8. Reuse generated or schema-derived types instead of duplicating provider shapes. Validate consumed fields and decide unknown-field handling per contract.
9. Separate expected failures from programming errors. Keep structured context sufficient to locate a decision without logging secrets. Keep CLI machine output free of diagnostic chatter.

Read [patterns.md](references/patterns.md) for examples. AGENTS.md owns test policy, security rules and configuration requirements.

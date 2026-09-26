---
name: verify-gate
description: Verify gate changes with the checks, the replay corpus, CEL conformance, the Node bundle and the guard. Use before handing off any change to gate code, policies, fixtures, dependencies, CI or instructions.
---

# Verify gate

Run from the repository root, using the Bun version pinned in `package.json`:

```bash
bun install --frozen-lockfile
bun run check
```

`check` runs typecheck, lint, the guard, `bun test` and the Node smoke check, and stops at the first failure. A pass means all five ran. When one fails, rerun only that script while fixing it, then run `check` again before handoff.

Documentation-only edits need `bun run lint` (prettier covers Markdown) and a link review. CI and tooling changes need the checks they affect, plus the real GitHub run: `gh run list --branch <branch>` and `gh run watch <id>`. Don't claim CI passes from a local run.

## Journeys

Each journey names what it proves and what would falsify it. Read the output, not only the exit code.

**Replay corpus.** `bun test packages/gate/test/replay.test.ts`. Each fixture in `packages/gate/test/replay/fixtures` evaluates an incident at recorded moments against every pinned policy and expects an exact outcome and reason set. It fails when a policy or evidence change moves any incident's outcome or reasons. The test count must equal the fixtures' evaluations times the pinned policies. A lower count means a fixture stopped loading.

**CEL conformance.** `bun test packages/cel/test/conformance.test.ts`. Every cel-spec case outside `conformance-known-failures.json` must pass, and a listed case must keep its kind. If it reports that known failures now pass, rerun with `CEL_CONFORMANCE_UPDATE=1` and check that the JSON diff only removes lines.

**Node bundle.** `bun run test:node` bundles `@gate/cel` and `@gate/gate` for Node and evaluates CEL and one policy decision under `node`. It must print `bundles ok on Node v<version>`. It fails when source code starts using a Bun-only API or a decision differs between runtimes. It covers only the smoke script's entry points.

**Guard.** `bun run guard` compares the working tree with the merge base of `HEAD` and `origin/main`. CI passes the PR base as `GATE_GUARD_BASE`. It must print `guard: no violations against <sha>`. Fetch `origin` first, because a stale `origin/main` hides changes that have already landed. A pass can also mean the guard is broken, so after committing a change to `scripts/guard.ts`, confirm it still rejects a real violation in a throwaway worktree:

```bash
set -eu
probe="$(mktemp -d)/gate-guard-probe"
git worktree add --detach "$probe" HEAD
echo ' ' >> "$probe/packages/gate/policies/supply-chain-policy-v1.json"
if (cd "$probe" && GATE_GUARD_BASE=HEAD bun scripts/guard.ts); then echo 'guard missed an edited policy'; fi
git worktree remove --force "$probe"
```

The guard must print `published policies are immutable` and exit 1.

## Not yet verifiable

`gate verify <lockfile>` has no entry point on `main`: `packages/gate/package.json` has no `bin`. Once it lands, add a journey to this skill only after running it. The journey runs offline against a recorded lockfile, checks one JSON decision per node with policy digests, checks exit 0 only when every node is ACCEPT and non-zero otherwise, and runs the same bundle under Node.

Until then, report CLI behavior as unverified. Unit tests of the parser or adapters don't check the command.

## Evidence and cleanup

Keep run output outside the repository, in the session scratchpad or `mktemp -d`. `eslint .` and `prettier --check .` scan everything under the root. Report the commit (`git rev-parse HEAD`), whether the worktree was dirty, each command with its pass/fail summary line, and every journey you didn't run. Remove only the worktrees and temp directories the verification created.

Never change an expected outcome, fixture, known-failure entry or guard rule to make a run pass. [gate-supply-chain](../gate-supply-chain/SKILL.md) covers what to do instead.

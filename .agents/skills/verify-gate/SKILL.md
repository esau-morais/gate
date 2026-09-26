---
name: verify-gate
description: Verify gate changes with the checks, the replay corpus, CEL conformance, the Node bundle and the guard. Use before handing off any change to gate code, policies, fixtures, dependencies, CI or instructions.
---

# Verify gate

Run from the repository root, using the Bun version pinned in `package.json`:

```bash
git fetch origin
bun install --frozen-lockfile --ignore-scripts
bun run check
```

A pass requires every script in `check` to run. While fixing a failure, rerun only the failing script, then run `check` again before handoff.

Documentation-only edits need `bun run lint` and a link review. CI and tooling changes also need the real GitHub run (`gh run list --branch <branch>`, then `gh run watch <id>`). A local pass isn't evidence that CI passes.

## Journeys

Each journey names what it proves and what would falsify it. Read the output, not only the exit code.

**Replay corpus.** `bun test packages/gate/test/replay.test.ts` evaluates each incident in `packages/gate/test/replay/fixtures` at its recorded moments and expects an exact outcome and reason set. It fails when a policy or evidence change moves any incident. The test count must equal the number of fixture evaluations times the number of policies `replay.test.ts` loads. A lower count means a fixture stopped loading.

**CEL conformance.** `bun test packages/cel/test/conformance.test.ts` fails when a cel-spec case outside `conformance-known-failures.json` fails, or when a listed case changes kind. When it reports that known failures now pass, rerun with `CEL_CONFORMANCE_UPDATE=1` and check that the JSON diff only removes lines.

**Node bundle.** `bun run test:node` must print `bundles ok on Node v<version>`. It fails when source starts using a Bun-only API, or when a decision differs between runtimes. It covers only the smoke script's entry points.

**Guard.** `bun run guard` compares the working tree with the merge base of `HEAD` and `origin/main`. It must print `guard: no violations against <sha>`. A stale `origin/main` hides changes that already landed, so fetch first. A pass can also mean the guard is broken. After committing a change to `scripts/guard.ts`, confirm it still rejects a real violation in a throwaway worktree:

```bash
set -eu
probe="$(mktemp -d)/gate-guard-probe"
git worktree add --detach "$probe" HEAD
trap 'git worktree remove --force "$probe"' EXIT
cd "$probe"
bun install --frozen-lockfile --ignore-scripts
echo ' ' >> packages/gate/policies/supply-chain-policy-v1.json
if GATE_GUARD_BASE=HEAD bun scripts/guard.ts 2> guard.log; then exit 1; fi
grep -F 'published policies are immutable' guard.log
```

The probe must print the matching line and exit 0. Any other result means the guard missed the edit or crashed.

## Unverified journeys

This skill has no `gate verify` CLI journey yet. Add one only after running it offline against a recorded lockfile, under Bun and Node. Until then, report CLI behavior as unverified. Unit tests of the parser or adapters don't exercise the command.

## Evidence and cleanup

Keep run output outside the repository, in the session scratchpad or `mktemp -d`. Report the commit (`git rev-parse HEAD`), whether the worktree was dirty, each command's pass/fail summary line, and every journey you didn't run. Remove only the worktrees and temp directories the verification created.

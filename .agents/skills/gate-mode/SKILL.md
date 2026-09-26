---
name: gate-mode
description: Apply gate's working conventions for autonomous, research-backed implementation slices running alongside other agents, from first edit to merged PR.
---

# gate mode

## Take the slice

Follow [babysit-pr](../babysit-pr/SKILL.md) from the first edit through merge, [verify-gate](../verify-gate/SKILL.md) before handoff, and [gate-supply-chain](../gate-supply-chain/SKILL.md) whenever it applies. The task's acceptance criteria define the slice. Don't expand it from PLAN.md or REVIEW.md.

Other agents often work in this repository at the same time. Before editing, run `git status` and `git worktree list`. If the checkout has changes you didn't make or sits on another task's branch, don't touch it. Work in a new worktree outside the repository directory, where the root `eslint .` and `prettier --check .` won't scan it:

```bash
git fetch origin
git worktree add -b <type>/<slice> ../gate-<slice> origin/main
cd ../gate-<slice> && bun install --frozen-lockfile --ignore-scripts
```

## Settle questions yourself

Answer open questions by research and analysis. Ask only when a decision, access or authorization that only the maintainer can give blocks progress. When you do, give your recommendation.

Use primary sources: the registry, OSV, GitHub advisories, upstream source at the installed version, and specs. Cite the URL and the date you checked for every claim about external behavior. If a source can't settle a question, say so and treat the fact as unknown. Don't fill it with a plausible guess.

When asked for a better approach, check the platform's built-in APIs and the installed library's own docs and source first, and confirm edge-case behavior with a small run. A rename isn't a better approach. When a decision changes, update the scripts, config, dependencies and docs that depended on it before continuing.

## Work test-first

For a behavior change, write the test first. Run it and confirm it fails for the intended reason before writing the fix. A test that fails on a typo or a missing import proves nothing. Keep both runs' summary lines for the report.

## Report

Lead with the PR link. Beyond what AGENTS.md asks for, list:

- fixtures used, with source URLs and their gaps
- the failing-before and passing-after runs
- dependencies added, with their §12 entries
- questions you settled, and the basis for each

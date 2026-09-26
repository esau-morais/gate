# gate plan

**Version:** v2 · 2026-09-26. Replaces the first plan (in git history). Accepted decisions live in [REVIEW.md](REVIEW.md) §12. This file says what gate is for and what comes next.

## Positioning

gate shows a better trust model for npm dependencies: every install decision follows a published policy, lands in a signed log, and anyone can replay it without trusting the operator. It also aims for a better experience than npm's own tooling: one command, reasons a person can act on, no noise on healthy repos.

gate is not an npm replacement. It works with the registry and clients people already use. A new registry would still proxy npm for almost every package, and running one means paying for bandwidth, handling takedowns and name disputes, and working under npm's terms ([REVIEW.md](REVIEW.md) §6.8).

Who it's for, in order:

1. Maintainers and small teams who want a CI check. Free.
2. Platform and security teams who want one policy and one log across many repos. Paid hosted service.
3. Auditors and compliance, who need to show why a dependency was allowed. The EU Cyber Resilience Act's SBOM and vulnerability-handling duties apply from 2027-12-11 ([summary](https://digital-strategy.ec.europa.eu/en/policies/cra-summary)).

## Goals

1. **Anyone can verify.** The verifier, policies, log format and replay are MIT (plus two Apache-2.0 files ported from sigstore-js) and run offline.
2. **Fails closed.** Missing evidence is never a pass (AGENTS.md).
3. **Works with the clients people use** through `gate verify` in CI: package-lock today, pnpm-lock in M2, yarn.lock and bun.lock after. Client hooks are early warnings.
4. **Sends nothing an install wouldn't, by default.** gate fetches public data (packuments, attestations, feed snapshots) and matches locally. It never uploads a lockfile or a dependency list.
5. **Good experience.** Targets for M2. Today `verify` runs with no flags in a package-lock repository and passes npm workspace links, and prints JSON lines only:
   - One command on a real repo, no config: `npx <name> verify`.
   - Every non-ACCEPT line names the rule, the evidence, and the next step: the waiver to write, or the time the version clears `release_age`.
   - Human output on a terminal, JSON lines with `--json`.
   - A 1,000-node lockfile in under 10 s with a warm cache and under 60 s cold. Warm means a cache restored from an earlier run, as in CI, so packuments are revalidated and the feed may be downloaded again. These are targets. On 2026-09-26 npm/cli (883 nodes) took 18.4 s warm in that sense, so the warm target isn't met yet. The feed download and packument revalidation make up most of the gap (REVIEW §12, Zero-config run).

Non-goals: replacing npmjs.org, a public mirror, competing on threat intelligence, other ecosystems, and classifiers that block on their own.

## Roadmap

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M1: offline verify** (current) | `gate verify` for package-lock v2/v3 on policy v2, decision log, `gate replay` of v1 and v2 records | Done in code. Remaining: README |
| **M2: network mode and first release** | Live evidence (below), workspace defaults, human output, pnpm-lock parser, a README that says the age window buys time for feeds and isn't a control by itself (REVIEW §6.10), publish to npm with trusted publishing and staged releases (REVIEW §11), a GitHub Action, and a first test of the log against a local witness | Runs on 10 public repos of different sizes with no config. False-positive budget met on all 10 and the numbers published. Replay corpus unchanged |
| **M3: logs that outlive CI, hosted beta** | Log persistence, witness-network testing list, team dashboard beta | A PR run and a main-branch run on the same repo produce one consistent log. External witness cosigns before anything is charged |
| **M4: one of three**, chosen from M3 demand | A per-customer verifying proxy that also gates tarballs, a small publishing registry for a first-party namespace, or a package browser that shows provenance and gate's verdicts | Decided when M3 ends |

### M2: network mode

- **Packuments and attestations** from registry.npmjs.org, cached on disk with their fetch time. The fetch time goes into the evidence, so replay stays exact.
- **Sigstore trusted root** through `@sigstore/tuf`, already researched in REVIEW §11. Offline mode keeps reading a recorded root.
- **Malware feed** as a downloaded snapshot of ossf/malicious-packages, matched locally with the manifest rules gate already has. The replay corpus depends on its `import_time` fields, and per-package API queries would leak the dependency list. Settled in REVIEW §12 (Malware feed snapshot): the GitHub tarball, 45.8 MB against 216.7 MB for OSV's npm export.
- **No deps.dev by default.** Per-package queries go to a third party. Allowed as an opt-in cross-check.
- **Request budget.** A single run fetches one packument per package. npm's terms treat 5M requests a month from one organization as unreasonable, so the cache matters most for the hosted service.

### False-positive budget

Evaluate each benign repo at a time after its newest dependency has cleared `release_age`. On those runs:

- zero REJECT;
- at most 1% of nodes quarantined for anything other than `release_age`, and each one checkable by a reviewer.

The 1% is a starting number. Revisit it once the 10 repos are measured.

### M3: logs in CI

CI runners are thrown away, and the log is single-writer. The plan to test:

- One log per organization, written by one job on the main branch (or a scheduled job). PR runs verify without logging.
- The log lives in object storage or a dedicated git branch. The signing key lives in the CI secret store and never in the log or the evidence.
- In M2, test the existing log against a local witness ([litewitness](https://github.com/FiloSottile/torchwood), BSD-3-Clause). The protocol is plain HTTP.
- In M3, join witness-network.org's testing list. It takes an email with the log's origin, key, checkpoint rate, the list wanted and a contact ([participate](https://witness-network.org/participate/)).
- Before a hosted log is sold, witnesses run by someone else must cosign, or customers are back to trusting the operator. The staging list has three (Geomys, Mullvad, TrustFabric). No production list exists yet.

## Business model

| Layer | Contents | Price model |
|---|---|---|
| Free, MIT | CLI, policies, log format, replay, client adapters, self-hosted proxy when it exists | Free. This is how people find gate |
| Hosted | Log hosting with witnesses, dashboard across repos, waiver approvals, policy management | Per seat. Comparable tools charge $8 to $79 per user a month ([vlt](https://www.vlt.io/pricing), [StepSecurity](https://www.stepsecurity.io/pricing), [Socket](https://socket.dev/pricing)) |
| Enterprise | SSO, audit exports, compliance reports, support for the self-hosted proxy | Contract |
| Grants | Funded milestones | NLnet CodeSupply, see below |

The hosted service is separate code and closed. Everything needed to check a decision stays open source (LICENSE), because the pitch is that nobody has to trust the operator.

Don't count on donations. Verdaccio's [OpenCollective](https://opencollective.com/verdaccio) budget is about $444 a year.

### Constraints

- **npm security data.** npm's [terms](https://docs.npmjs.com/policies/open-source-terms) forbid giving others "npm data about the security of Packages". The clause came from the Node Security Platform in 2018 and its examples are audit and advisory data. npm hasn't said whether it covers attestations. So the hosted service takes advisories from GHSA (CC-BY 4.0, attribute by linking to github.com/advisories) and malware data from ossf/malicious-packages (Apache-2.0), treats attestations as evidence it verifies itself, and gets npm's written position before showing customers any npm-derived security field.
- **Request volume.** The same terms call 5M requests a month from one "individual, organization, or group of affiliated companies" unreasonable and point heavy users to npm sales. A hosted proxy serving unrelated customers most likely counts as one organization. Cache hard, and talk to npm before launching one. The CLI run from each user's own CI is not affected.
- **deps.dev.** Its data is CC-BY 4.0 and caching is allowed, but Google's API terms forbid offering an API that works substantially like theirs. Opt-in cross-check only.
- **Competition.** Socket and Aikido each raised $60M in 2026 ([Socket](https://www.securityweek.com/socket-raises-60-million-at-1-billion-valuation/), [Aikido](https://www.aikido.dev/blog/aikido-funding-series-b)). gate competes on verifiable decisions, not on detection.

### Funding

[NLnet CodeSupply](https://nlnet.nl/codesupply/) funds work on package metadata, including security data. A first grant is €5k to €50k, and €60k is the lifetime cap per applicant. The first deadline is 2026-11-03 12:00 CET, with new calls about every two months into early 2027. Payment comes per milestone. Decisions take three to five months.

- Individuals can apply and MIT counts as an open license. No prior adoption is required.
- A "European dimension" is a knock-out criterion. Applicants from outside the EU and Horizon Europe countries rank lower and need exceptional quality plus a European collaborator or a clear European contribution ([eligibility](https://nlnet.nl/codesupply/eligibility/)).
- NLnet doesn't want AI-generated proposals, and asks for the prompts if AI was used. Write it by hand.
- Scope: M2, network mode plus the false-positive study, split into paid milestones.

## Outreach

Posts on X, Reddit and similar sites, starting before M2 ships:

- One finding per post, with the terminal output: the Sigstore verifier trap, `npm ci` skipping the extension hook, the TanStack lockfile.
- When an npm attack lands, run the policy against it and post the result the same day.
- The launch post waits for M2, when people can run gate on their own repo.

## Threat coverage

The threat model from the first plan. Names in parentheses are the replay corpus cases that prove it.

| Attack | Covered by | Status |
|---|---|---|
| Maintainer account takeover | `release_age`, plus `publisher_unknown` and `provenance_unavailable` where evidence is gone | Covered (chalk). `publisher_changed` has no incident case |
| Stolen publish token | `release_age`, `trust_downgrade`, `new_install_script` | Covered (nx) |
| Maintainer handover | `publisher_recent` | Covered (event-stream) |
| Compromised CI, valid provenance | `release_age`, and `exotic_source` for the injected git dependency | Covered inside 72h (TanStack). Workflow checks not built |
| Worm | `release_age`, `new_install_script` | Covered (Shai-Hulud) |
| Same publisher, small malicious change | Nothing | Missed (postmark-mcp). Needs content analysis |
| Typosquat | `feed_match` once listed | No name-similarity rule |
| Dependency confusion | `exotic_source` for non-registry sources | Private-scope pinning not built |
| Malicious registry or mirror | Sigstore subject match, `integrity_mismatch` | npm registry signatures not checked |
| Operator rewrites history | Signed tlog-tiles log, `gate replay` | No witnesses yet (M3) |

## Open decisions

Decide before the milestone named.

| Decision | By |
|---|---|
| Apply to NLnet, and the European dimension | 2026-11-03 |
| npm package name for the CLI | M2 |
| Certificate output: in-toto VSA or keep JSON lines (REVIEW §6.7) | M2 |
| Urgent-fix lane for `release_age` (REVIEW §6.4) | M2 |
| Who signs policy v3 and how orgs upgrade (REVIEW §6.9) | Before v3 |
| Send the CEL fixes upstream or keep the fork alone | M2 |
| Which M4 option | End of M3 |

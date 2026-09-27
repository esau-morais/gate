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
5. **Good experience.** Targets for M2. Today `verify` runs with no flags in a package-lock repository, passes npm workspace links, and prints a report with the next step for each rule (JSON lines with `--json`):
   - One command on a real repo, no config: `npx <name> verify`.
   - Every non-ACCEPT line names the rule, the evidence, and the next step: the waiver to write, or the time the version clears `release_age`.
   - Human output on a terminal, JSON lines with `--json`.
   - A 1,000-node lockfile in under 10 s with a warm cache and under 60 s cold. Warm means a cache restored from an earlier run, as in CI, so packuments are revalidated and the feed may be downloaded again. These are targets. On 2026-09-26 npm/cli (883 nodes) took 18.4 s warm in that sense, so the warm target isn't met yet. The feed download and packument revalidation make up most of the gap (REVIEW §12, Zero-config run).

Non-goals: replacing npmjs.org, a public mirror, competing on threat intelligence, other ecosystems, and classifiers that block on their own.

## Roadmap

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M1: offline verify** (current) | `gate verify` for package-lock v2/v3 on policy v2, decision log, `gate replay` of v1 and v2 records | Done in code. Remaining: README |
| **M2: network mode and first release** | Live evidence (below), workspace defaults, human output, pnpm-lock parser, a README that says the age window buys time for feeds and isn't a control by itself (REVIEW §6.10), publish to npm with trusted publishing and staged releases (REVIEW §11), a GitHub Action, a first test of the log against a local witness, and an exhaustive test of the policy invariants (REVIEW §12) | Runs on 10 public repos of different sizes with no config. False-positive budget met on all 10 and the numbers published. Replay corpus unchanged |
| **M3: logs that outlive CI, hosted beta** | Log persistence, witness-network testing list, team dashboard beta, and the M3 rows of After M2 below | A PR run and a main-branch run on the same repo produce one consistent log. External witness cosigns before anything is charged |
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

Evaluated with no config at `2026-09-27T00:55:32Z`, on evidence fetched between 00:55 and 01:01 UTC. vscode was evaluated at `2026-09-27T21:41:00Z`, 72 hours after its newest dependency, on the same evidence. v2 is `gate verify` at c28e0bc. v3 is the proposal in REVIEW §12 plus the SLSA v0.2 evidence fix, run in a scratch copy of gate. No run had a REJECT. Each column counts nodes quarantined for anything other than `release_age`:

| Repository | Nodes | v2 | v3 | v3 without `integrity_unknown` and fsevents |
|---|---|---|---|---|
| camsong/You-Dont-Need-jQuery@d413b575 | 99 | 9 (9.1%) | 2 (2.0%) | 1 (1.0%) |
| npm/cli@0c3b82a9 | 883 | 644 (72.9%) | 606 (68.6%) | 23 (2.6%) |
| sigstore/sigstore-js@769a53d8 | 1,034 | 844 (81.6%) | 820 (79.3%) | 13 (1.3%) |
| open-telemetry/opentelemetry-js@547bff40 | 1,685 | 233 (13.8%) | 8 (0.5%) | 7 (0.4%) |
| lerna/lerna@752bdbba | 2,232 | 481 (21.6%) | 260 (11.6%) | 10 (0.4%) |
| microsoft/TypeScript@4f5ddae2 | 327 | 42 (12.8%) | 21 (6.4%) | 21 (6.4%) |
| Leaflet/Leaflet@125bda1e | 394 | 50 (12.7%) | 5 (1.3%) | 3 (0.8%) |
| actions/checkout@f548e57e | 586 | 43 (7.3%) | 3 (0.5%) | 2 (0.3%) |
| mozilla/pdf.js@d52fdf41 | 964 | 95 (9.9%) | 3 (0.3%) | 2 (0.2%) |
| microsoft/vscode@66a33c85 | 1,659 | 201 (12.1%) | 32 (1.9%) | 31 (1.9%) |

v2 misses the budget on all 10. v3 meets it on otel-js, checkout and pdf.js. It also meets it on Leaflet and lerna once two things are set aside. The first is fsevents, whose malware-feed entry has a version range gate can't evaluate yet, which is separate work. The second is lockfile integrity. Under v3, every remaining quarantine falls in one of these groups:

- `integrity_unknown` on 584, 811 and 251 entries that have neither `resolved` nor `integrity`. The lockfile pins no bytes. With npm 10.9.8, `npm install`, a reinstall without `node_modules` and `--package-lock-only` left such an entry unchanged, and `npm update` refilled it but can move versions.
- New publishers less than 90 days old. TypeScript 7.0.2 and 20 `@typescript/typescript-*` packages came from `microsoft1es` instead of `typescript-deploys` on 2026-07-08, and they clear on 2026-10-06. The others are picomatch 4.0.5, @devcontainers/cli 0.88.0, @vscode/gulp-vinyl-zip 2.7.0, @jest/get-type 30.5.0 and process-warning 5.1.0.
- `publisher_recent` less than 90 days old: conventional-changelog-preset-loader 6.0.1, conventional-commits-filter 6.0.1 and @npmcli/arborist 9.9.1.
- 8 new or changed install hooks, including core-js 3.50.0, protobufjs 7.6.6 and es5-ext 0.10.64.
- Unknown evidence: 6 versions whose earlier documents lack `_npmUser`, own-keys 1.0.1, whatwg-url 17.1.1's missing attestation, and @tufjs/canonical-json 2.0.0, which gate reads since [SLSA v0.2 provenance](REVIEW.md#slsa-v02-provenance).
- fsevents' `feeds_unavailable`.

At this size, 1% of a 99-node repository is zero nodes, and one publisher switch at Microsoft quarantines 21. Counting distinct packages per repository may suit the budget better.

### M3: logs in CI

CI runners are thrown away, and the log is single-writer. The plan to test:

- One log per organization, written by one job on the main branch (or a scheduled job). PR runs verify without logging.
- The log lives in object storage or a dedicated git branch. The signing key lives in the CI secret store and never in the log or the evidence.
- In M2, test the existing log against a local witness ([litewitness](https://github.com/FiloSottile/torchwood), BSD-3-Clause). The protocol is plain HTTP.
- In M3, join witness-network.org's testing list. It takes an email with the log's origin, key, checkpoint rate, the list wanted and a contact ([participate](https://witness-network.org/participate/)).
- Before a hosted log is sold, witnesses run by someone else must cosign, or customers are back to trusting the operator. The staging list has three (Geomys, Mullvad, TrustFabric). No production list exists yet.

### After M2: verification and detection

Checked 2026-09-26 against the conversation that started gate ([research](research/chatgpt-open-source-npm-alternatives.md)) and the code on main. None of these is built.

| Item | Why | Facts | When |
|---|---|---|---|
| Lockfile certificate | The conversation's "verified graph", and REVIEW §1's reason gate exists. Nothing signed says "lockfile X passed policy P at time T". gate prints per-node lines and logs per-node records | A SLSA VSA names one resource, a policy URI and digest, PASSED or FAILED, and the input attestations. It has no field for per-node decisions ([VSA v1.1](https://slsa.dev/spec/v1.1/verification_summary)). `npm sbom --package-lock-only` builds an SBOM from the lockfile alone ([npm sbom](https://docs.npmjs.com/cli/v11/commands/npm-sbom)) | Format in M2 (open decisions). Build in M3, because a certificate should point at a log entry that outlives the CI runner |
| Evidence an auditor can re-check | Replay trusts the logged evidence. Records hold derived facts, not the packuments and bundles behind them (REVIEW §12, gate replay) | Sigstore bundles verify on their own. A packument is unsigned except for npm's registry signature over each version's name, version and integrity | M3, with log persistence: log each raw input's digest and keep the files with the log |
| npm registry signatures | Most packages have no provenance, so only TLS ties their integrity to npm | npm signs `name@version:integrity` with ECDSA P-256 ([docs](https://docs.npmjs.com/about-registry-signatures)). npm 12.1.0 fetches the keys as `registry.npmjs.org/keys.json` through `@sigstore/tuf` (`lib/utils/verify-signatures.js`), which gate already uses | M3 |
| Client adapters | The conversation's second check at install time. They are early warnings only (REVIEW §11) | Zero dependencies (AGENTS.md) | M3 |
| New dependency between versions | Would also have caught event-stream and axios (REVIEW §12, Replay corpus) | Needs only the packuments' dependency lists | After M3, as an evidence field and a rule in a new policy version |
| Capability diff between versions | Nothing in gate catches the postmark-mcp case below | Deterministic findings belong in evidence with their own rules. Claims are for probabilistic classifiers: a REJECT rule can't read them, and `gate verify` loads no org policy, so today claims change nothing | After M3. Classifiers never block on their own (non-goals) |
| Workflow checks | TanStack's compromise began with `pull_request_target` cache poisoning (REVIEW §6.5, [postmortem](https://tanstack.com/blog/npm-supply-chain-compromise-postmortem)) | zizmor's `dangerous-triggers` and `cache-poisoning` audits run offline ([audits](https://docs.zizmor.sh/audits/)) | After the capability diff, the same way |
| Metadata freshness | Freeze and rollback attacks on metadata (REVIEW §5). They matter once a proxy or mirror serves packuments | npm has no signed packuments: npm/rfcs #76 is open since 2019 (REVIEW, Resolved questions) | With the proxy (M4) |
| Typosquat, dependency confusion, client config checks, deprecated versions | The threat table below, REVIEW §6.6 (client config) and the conversation's "package not revoked" | Dependency confusion needs an organization's private scopes. gate doesn't read `deprecated` | Unscheduled. Revisit with the hosted tier. Publishing detection scores there would also show attackers the thresholds |

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
| Certificate output: in-toto VSA, gate's own signed statement, or keep JSON lines. A VSA has no field for per-node decisions (After M2) | M2 |
| Urgent-fix lane for `release_age` (REVIEW §6.4) | M2 |
| Who signs policy v3 and how orgs upgrade (REVIEW §6.9) | Before v3 |
| Adopt the SupplyChainPolicy/v3 proposal, including its 90-day identity window (REVIEW §12) | Before v3 |
| Send the CEL fixes upstream or keep the fork alone | M2 |
| Which M4 option | End of M3 |

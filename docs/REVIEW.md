# Plan review: gate

Reviewed 2026-09-25 against the first plan (`docs/PLAN.md` before 2026-09-26, in git history). Three research passes checked the plan's factual claims, its tech stack, and the projects and gaps around it. Each claim below links to a source that was opened during the review. *Opinion* marks my own judgment. Recommendations here are proposals until [PLAN.md](PLAN.md) or §12 absorbs them.

## 1. Summary

The facts hold up. All 19 claims I checked trace to real sources, and none look invented. The problems are in the design:

1. The M1 centerpiece, a proxy that hides young versions in metadata, already exists as open source (Verdaccio's `@verdaccio/package-filter`, Aikido Safe Chain, pkggate). npm, pnpm, Yarn and Bun each have a release-age setting too. M1 as written ships something people can already get.
2. Hiding versions in metadata does not stop installs from a lockfile. The plan never gates the tarball endpoint.
3. Once a proxy sits in front of npm, npm takes its signing keys from the proxy. The plan also has no freshness protection for filtered metadata.
4. Cedar fits a Go service poorly. The validator and the symbolic analysis the plan relies on exist only in Rust.
5. PubGrub and resolvo don't model npm's duplicate versions, so the `ourpm` resolver plan doesn't work as written.
6. There is no lane for urgent security fixes that land inside the quarantine window.
7. Quarantine is anchored on the gate's own clock. A freshly deployed gate would quarantine every version it hasn't seen yet, and two gates would disagree about the same version.

Nobody else ships the versioned policy, the public decision log, or a lockfile certificate a CI job can check. *Opinion:* build those first and treat the proxy as one way to enforce them (§7).

## 2. Fact corrections

| Plan | Actual | Source |
|---|---|---|
| D5: Bend "has open soundness bugs (#1001)" | #1001 was a real soundness bug: one `@unsafe` fill in an imported file silently proved every law. It is closed, fixed in PR #1033. The decision to not use Bend still stands on maturity grounds | https://github.com/bendlang/bend/issues/1001 |
| §6, §14: pnpm 11 as the current reference | pnpm 11.0 shipped 2026-04-28 with `minimumReleaseAge` 1440 min, `blockExoticSubdeps` and `strictDepBuilds` on. The current release is 12.7.0 (2026-09-25). pnpm 12 is a Rust rewrite from August 2026. The pnpmfile docs still list `afterAllResolved`, but the 12.0 notes don't confirm JS hooks still run, so test §7.4's integration against 12.x | https://pnpm.io/blog/releases/11.0 · https://github.com/pnpm/pnpm/releases · https://pnpm.io/blog/releases/12.0 · https://pnpm.io/pnpmfile |
| §6: "same idea as pnpm `trustPolicy: no-downgrade`" | Correct idea. `trustPolicy` defaults to `off`, so pnpm users must opt in | https://pnpm.io/settings/dependency-resolution |
| §15: Amalfi, 1,017 FP vs 78 TP in a week | The week's totals match, but 932 of the FPs came on day 1, before retraining, and the paper calls them likely overstated. Days 2 to 7: 85 FP vs 44 TP. Still a bad ratio, and still a fair warning | https://arxiv.org/pdf/2202.13953 (Table 1) |
| §7.5: "Sigstore has no certificate revocation" | Fulcio avoids revoking leaf certificates by keeping them short-lived. TUF can revoke compromised roots and keys. The plan's conclusion, to keep revocation as logged registry state, still holds | https://docs.sigstore.dev/about/security/ · https://docs.sigstore.dev/about/threat-model/ |
| §10: Go proxy keeps PII for 30 days | "Not more than 30 days", a maximum | https://proxy.golang.org/privacy |
| D8: Jev is hosted-only | This is an inference. TypeSafe documents only an HTTP API and SDKs, and Cloudflare lists Jev as a third-party model proxied to TypeSafe. No page rules out self-hosting | https://docs.typesafe.ai/llms.txt · https://developers.cloudflare.com/ai/models/typesafe/jev/ |
| §7.3: Tessera "production-ready since beta" | v1.0.0 went GA on 2025-09-22. The latest is v1.0.4 (2026-07-16). Storage drivers exist for AWS, GCP, MySQL and POSIX | https://pkg.go.dev/github.com/transparency-dev/tessera?tab=versions |
| §7.4, §9: "reuse PubGrub or resolvo" | PubGrub assumes one version per package, and npm allows duplicates through nesting. resolvo is the solver behind conda tooling (rattler, pixi). The only Go npm resolver found, `deps.dev/util/resolve/npm`, models npm 6.14.12, which predates automatic peer installs | https://pubgrub-rs-guide.pages.dev/limitations/multiple_versions · https://github.com/prefix-dev/resolvo · https://pkg.go.dev/deps.dev/util/resolve/npm |
| §7.2: OSSF Package Analysis as a maintained dependency | The last ten commits (May to 2026-07-21) are almost all dependency bumps. Treat it as maintenance mode | https://github.com/ossf/package-analysis/commits/main |
| §5.4, §7.2: OSS Rebuild as the T3 source | It covers only popular packages, "thousands" across npm, PyPI and crates. Its CLI needs Google Application Default Credentials. T3 will be rare | https://github.com/google/oss-rebuild |

These check out as written:
- TanStack, 2026-05-11: 84 artifacts across 42 packages, published with valid SLSA Build L3 provenance ([Unit42](https://unit42.paloaltonetworks.com/monitoring-npm-supply-chain-attacks/), [TanStack postmortem](https://tanstack.com/blog/incident-followup)).
- ChainDrop, 2026-08-04: 400+ packages, with a path that publishes through trusted-publisher workflows ([Microsoft](https://www.microsoft.com/en-us/security/blog/2026/08/04/chaindrop-supply-chain-compromise-anatomy-self-propagating-worm/)).
- `shai_hulululud`, 2026-06-17. socket.dev returned 403 during the review, so this was read through a [mirror](https://daily.dev/posts/npm-package-uses-prompt-injection-and-token-flooding-to-disr--jna5nkasv).
- npm policy changes: staged publishing, the v12 defaults, publish-time scanning.
- 25% trusted-publishing share of download volume, and 454,600 malicious packages in 2025.
- npm trusted publishing supports three providers: GitHub-hosted runners, GitLab.com shared runners, and CircleCI cloud.
- Licenses: pnpr is PolyForm Shield, VSR is FSL-1.1-MIT.
- PyPI quarantine: 1 of ~140 projects restored.
- Also confirmed: the Bun Security Scanner API, foxymirror, and the JSR governance board.

## 3. What changed since the plan's sources

- **Stage-only npm tokens (2026-09-18).** A token can run `npm stage publish` but can't publish directly. https://github.blog/changelog/2026-09-18-stage-only-npm-tokens-for-safer-automation/
- **Multiple trusted-publishing configurations per package (2026-09-03).** A staged package can't be approved until the malware scan finishes. Adding a second publisher config is now a legitimate event, so the "workflow or repo differs from previous versions" rule in §6 will fire on normal behavior unless it accounts for this. https://github.blog/changelog/2026-09-03-multiple-trusted-publishing-configurations-for-npm/
- **npm `min-release-age` (11.10.0), plus `min-release-age-exclude` and `before`.** Microsoft's ChainDrop post recommends npm v12 plus `min-release-age`. https://docs.npmjs.com/cli/v11/using-npm/config/
- **Yarn:** `npmMinimalAgeGate` (1 day default), and postinstall scripts off by default since 4.14. https://yarnpkg.com/features/security
- **Dependabot:** 3-day cooldown by default, security updates exempt. https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference
- **More 2026 incidents for the replay corpus:**
  - Bitwarden CLI (04-22)
  - SAP CAP (04-29)
  - node-ipc (05-14)
  - `@redhat-cloud-services` (06-01)
  - AsyncAPI (07-14)

  Sources: [Unit42](https://unit42.paloaltonetworks.com/monitoring-npm-supply-chain-attacks/), [StepSecurity](https://www.stepsecurity.io/blog/node-ipc-npm-supply-chain-attack).

## 4. Overlapping projects

| Project | License | What overlaps | What it leaves open |
|---|---|---|---|
| [Verdaccio package-filter](https://github.com/verdaccio/verdaccio/blob/8.x/packages/plugins/package-filter/README.md) | Verdaccio project (plugin license not checked) | `minAgeDays`, block by scope/name/range, recomputes `latest` | Filters metadata only. Cached tarballs still install. No provenance. Filter API marked experimental |
| [Aikido Safe Chain](https://github.com/AikidoSec/safe-chain) | AGPL-3.0 + commercial | Strips young versions (48h default) and blocks direct tarball fetches. Exempts CVE fixes after a malware check | Per-machine wrapper. No provenance tiers, no log |
| [pkggate](https://github.com/daneb255/pkggate) | MIT | Self-hosted npm/PyPI proxy, OSV MAL mirror, age rules, JSONL audit log, re-checks at tarball time | Early prototype, no provenance |
| [Datadog SCFW](https://github.com/DataDog/supply-chain-firewall) | Apache-2.0 (v4 in Go) | Install wrapper, checks malicious-packages and OSV | Wrapper only |
| [Socket Registry Firewall](https://github.com/SocketDev/socket-registry-firewall) | Proprietary | Self-hosted metadata-filtering proxy, air-gapped mode | Closed |
| [Chainguard Libraries JS](https://www.chainguard.dev/libraries/javascript) | Commercial | Rebuilt from source at SLSA L3, SBOMs | Paid |
| JFrog Curation, Sonatype Firewall | Commercial | Version policies, ML quarantine | Closed |
| npm, [pnpm](https://pnpm.io/supply-chain-security), Yarn, Bun | Open | Release-age gates. pnpm `trustPolicy` covers the plan's trust-downgrade rule | Per-client config, no central policy or log |
| [deps.dev API](https://docs.deps.dev/api/v3/) | Data CC-BY 4.0, caching allowed | npm provenance, advisories, resolved graphs | A data source, not a gate |
| [GUAC](https://github.com/guacsec/guac) | Apache-2.0 | Ingests SPDX, CycloneDX, SLSA, OpenVEX, Scorecard | No install-time gate |

I found no open project that combines provenance-based tiers, a transparency log of gate decisions, and a lockfile certificate. That combination is the plan's reason to exist.

## 5. Stack review

This table assumed Go. The maintainer later chose TypeScript, and §11 replaces the language-specific rows. The rows that don't depend on language still apply: CEL over Cedar, the formal spec deferred, OSS Rebuild as an optional signal, dropping the resolver, and adding freshness.

| Layer | Plan | Verdict | Recommendation |
|---|---|---|---|
| Language | Go | Keep | sigstore-go (stable, conformance-tested, Rekor v2), Tessera, cel-go, the deps.dev resolver and SCFW v4 are all Go |
| Policy | Cedar (cedar-go runtime, Rust Cedar in CI) | Change | cedar-go v1.8.0 has no stable validator (only `x/exp/schema`) and no symbolic analysis. `cedar-policy-symcc` is Rust-only and needs the cvc5 solver. Cedar answers permit/forbid over principal/action/resource, while gate rules return allow/quarantine/reject with reasons over attestation JSON. Use **CEL** (`cel.dev/cel-go`), which Kyverno already uses for image attestation policy. It is type-checked, not Turing-complete, and runs in linear time. Sources: [cedar-go](https://github.com/cedar-policy/cedar-go), [symcc](https://github.com/cedar-policy/cedar/tree/main/cedar-policy-symcc), [Kyverno](https://kyverno.io/docs/policy-types/image-validating-policy/), [cel-go](https://github.com/cel-expr/cel-go) |
| "Orgs can only add restrictions" | Proved with symbolic analysis | Simplify | *Opinion:* make it structural. Evaluate the canonical policy and the org rules separately, and take the stricter outcome. The evaluator can never loosen a decision, a few tests cover it, and it needs no SMT solver |
| Formal spec | Lean 4 or Dafny | Defer to M3 | If needed, consider [P](https://github.com/p-org/P). AWS uses it for S3, EBS and DynamoDB, and PObserve checks production logs against a spec, which fits a decision log. The maturity of Dafny's Go backend is unverified |
| Sigstore | sigstore-go | Keep | Skip sigstore-rs: pre-1.0, no attestation verification ([README](https://github.com/sigstore/sigstore-rs)) |
| Log | Tessera + witnesses | Keep | POSIX or MySQL driver for self-hosting. [witness-network.org](https://witness-network.org/) keeps shared witness lists, and its maintainers must approve each log |
| Static scan | GuardDog | Keep | It is Python (3.2.0, 2026-08-12), so run it as a separate worker container |
| Dynamic scan | Package Analysis | Demote | It needs privileged Docker plus gVisor, and its cost is undocumented. Consume the OSSF public BigQuery results (`ossf-malware-analysis.packages.analysis`) first. Run your own sandbox only for an allowlist |
| Rebuilds | OSS Rebuild | Optional signal | Popular packages only, CLI needs Google ADC |
| Resolver | PubGrub or resolvo for `ourpm` | Drop | Work from lockfiles. If a dependency closure is needed, use `deps.dev/util/resolve/npm` and accept its npm 6 model |
| Metadata freshness | Not covered | Add | Evaluate TUF-style signed, expiring snapshots, or [RSTUF](https://github.com/repository-service-tuf/repository-service-tuf). PEP 458 appendix A describes freeze, rollback and mix-and-match attacks ([PEP 458](https://peps.python.org/pep-0458/)). A Tessera log detects equivocation but doesn't prove freshness |
| Data source | Not covered | Add | deps.dev for provenance and publish-time cross-checks |
| PostgreSQL, S3/MinIO, Compose | As planned | Not reviewed | No research done on these |

## 6. Gaps, most important first

Status on 2026-09-26. Open items are scheduled in [PLAN.md](PLAN.md).

| Gap | Status |
|---|---|
| 1. Tarball endpoint | Deferred with the proxy. `gate verify` in CI is the enforcement point |
| 2. Upstream publish time | Done: `release_age` reads `time[version]` |
| 3. Keys and signatures | Trusted root done: network mode fetches it through TUF. npm registry signatures are open, scheduled for M3 (PLAN, After M2) |
| 4. Urgent-fix lane | Open. `release_age` is not waivable |
| 5. Provenance is not safety | Done: v1 has no trust tiers. Publisher continuity does the work. zizmor is scheduled after the capability diff (PLAN, After M2) |
| 6. Exotic sources and scripts | Done for sources (`exotic_source`) and scripts (`new_install_script`). Client config checks are not scheduled |
| 7. Certificate format | Open. Format in M2, certificate in M3 (PLAN, After M2) |
| 8. npm terms | Open, see PLAN.md |
| 9. Compromise of gate | Open. Policies are pinned by digest in the source. Release hardening is in M2, key roles are an open decision |
| 10. Cooldown critiques | Open. The M2 README covers it |

1. **Enforce at the tarball endpoint.** Verdaccio's filter says tarballs already cached "are not affected". Bun's age gate leaves `bun.lock` entries alone. Aikido blocks tarball downloads separately for this reason. Lockfile `resolved` URLs point at registry.npmjs.org, so npm needs `replace-registry-host`. npm 12's `allow-remote=none` default can also break proxied installs ([npm/cli#9548](https://github.com/npm/cli/issues/9548)). Add a tested setup page for each client. Add an M1 exit criterion: a lockfile pinned to a quarantined version fails to install through the gate.
2. **Anchor quarantine on the upstream publish time.** *Opinion:* `firstSeenAt` from the gate's clock makes decisions depend on when a gate was deployed, which breaks goal 2 (reproducible decisions). Use the packument `time[version]`, cross-checked against deps.dev. Keep `firstSeenAt` for audit, and raise a claim when a version first appears long after its stated publish time. That pattern suggests backdating.
3. **Keys and signatures.**
   - npm signs `name@version:integrity` for each version ([docs](https://docs.npmjs.com/about-registry-signatures)). Filtering versions and dist-tags keeps the remaining signatures valid. Changing `dist.integrity` breaks them.
   - Pass `dist.integrity`, `dist.signatures`, `dist.attestations`, `/-/npm/v1/keys` and `/-/npm/v1/attestations/*` through unchanged. pacote builds the attestation URL against the configured registry.
   - For registries other than registry.npmjs.org, npm skips Sigstore TUF and reads keys from `<registry>/-/npm/v1/keys` ([npm/cli#6418](https://github.com/npm/cli/pull/6418)). The proxy becomes the key trust root. Document that, and have `gate verify` fetch npm's keys from Sigstore TUF itself.
4. **Add an urgent-fix lane.** With `min-release-age` set, `npm audit fix` keeps the vulnerable version and exits non-zero (npm config docs). Aikido's model works. Exempt a young version if it fixes an OSV advisory that affects the project, passes feeds and scans, and keeps its trust level. Log it as its own decision reason.
5. **Provenance is evidence of where a build ran, not of safety.** D1 says this, but §5.4 still ranks T2 above T1 as more trusted. TanStack and ChainDrop both shipped with valid provenance. *Opinion:* let tiers describe the evidence, and let the identity-continuity rule do the security work. For workflow hygiene, run [zizmor](https://github.com/zizmorcore/zizmor) on the workflow file named in the provenance, at the provenance commit. TanStack's chain began with `pull_request_target` cache poisoning, which zizmor looks for.
6. **Exotic sources and install scripts.** Git, URL and file dependencies skip the registry, and postinstall scripts can download from anywhere. `gate verify` should fail on non-registry sources unless allowlisted, and check client config: npm 12 `allow-*`, pnpm `strictDepBuilds`/`blockExoticSubdeps`, and Yarn and Bun script allowlists.
7. **Certificate format.** Emit the Verified Graph Certificate as an in-toto attestation next to the SBOM from `npm sbom` (CycloneDX 1.5 / SPDX 2.3). GUAC and similar tools can then ingest it. A new format would need its own tooling.
8. **npm terms.** npm's open-source terms call 5M requests a month "unreasonable". They also forbid giving others npm's package security data ([terms](https://docs.npmjs.com/policies/open-source-terms)). A shared or public gate needs legal review. A self-hosted gate per organization carries less risk. The replication APIs also changed in 2025 ([changelog](https://github.blog/changelog/2025-02-26-changes-and-deprecation-notice-for-npm-replication-apis/)).
9. **Compromise of the gate itself.**
   - Use separate key roles and threshold signing for policy releases.
   - Plan how to revoke keys quickly.
   - Support air-gapped operation and per-tenant policy.
   - Harden this project's own releases: zizmor, [Scorecard](https://github.com/ossf/scorecard), SHA-pinned actions, and [SLSA Build L3](https://slsa.dev/spec/v1.1/levels).
10. **Cooldown critiques.** Sonatype argues that time is not trust ([post](https://www.sonatype.com/blog/software-dependency-cooldowns-are-a-symptom-not-a-strategy)). Cal Paterson calls cooldown users free-riders who wait for others to find the malware ([post](https://calpaterson.com/deps.html)). A patient attacker can wait out the window. The docs should say the window exists to give feeds and scanners time, and that it isn't a control by itself.

## 7. Suggested roadmap change (*Opinion*)

| Phase | Change |
|---|---|
| M1 | `gate verify`, the versioned policy, and the decision log, with no proxy. It works with every client, avoids npm's terms on redistribution, and doesn't move key trust. Input is a lockfile, output is an in-toto certificate and a CI exit code |
| M2 | The proxy, enforcing the same policy on metadata **and** tarballs. Teams that only want quarantine can use Verdaccio's package-filter and run `gate verify` in CI |
| M3 | Justify the publishing registry again. npm now has staged publishing, stage-only tokens, multiple trusted-publisher configs and publish-time scanning. What npm still lacks is self-hosted OIDC identities, an open policy and a public decision log |
| `ourpm` | Drop until a need appears. Lockfiles from existing clients are enough input |

## 8. Answers to open decisions (§14) where research helps

1. **Verdaccio vs Go proxy.** Verdaccio's filter doesn't gate tarballs, and its filter API is experimental. Tarball enforcement and the log are core to the plan, so build in Go (*Opinion*). Use Verdaccio's package-filter as the baseline in the evaluation.
2. **Quarantine window.** Current defaults: npm and pnpm 1 day, Yarn 1 day, Aikido 48h, Dependabot 3 days, foxymirror 7 days. Start at 72h and adjust using the replay suite's publish-to-takedown times.
3. **Lean vs Dafny.** Neither before M3. Look at P or TLA+ then.
4. **Jev.** No change: optional, off by default.

## 9. Language choice

A second round of research (2026-09-25) compared Go, Rust and TypeScript for gate's specific needs.

| Need | Go | Rust | TypeScript/Bun |
|---|---|---|---|
| Sigstore verification | sigstore-go, stable, 140/140 conformance | sigstore-rust 140/140 (new repo; old sigstore-rs is pre-1.0 without attestations) | sigstore-js 140/140, the library the npm CLI uses via pacote |
| TUF client | go-tuf v2.4.2 | sigstore-rust 100% on the TUF suite; tough active | tuf-js 99% |
| tlog-tiles, checkpoints, witnesses | Tessera v1.0.4, sunlight, transparency-dev/formats | Cloudflare Azul crates | No general library. `@cloudflare/signed-note-wasm` only |
| CEL policy | cel-go: type-checking, `CostLimit`, interrupts | cel-rust 0.14 | cel-js 8.0 type-checks but has no runtime cost limit. `@bufbuild/cel` is beta |
| npm semver | `deps.dev/util/semver` models npm quirks | `nodejs-semver`, npm parity unverified | `semver`, the parser npm uses |
| Lockfile parsing | osv-scalibr: package-lock, pnpm, yarn (v1 and berry), bun.lock | `chaste` 0.6, low use. pnpm 12's crate is unpublished | arborist, `@pnpm/lockfile.fs`, `@yarnpkg/parsers`. No bun.lock parser found |
| Own dependencies | `go` checks every module against sum.golang.org by default. govulncheck reports only reachable vulns | crates.io had account-takeover malware live 86-107 min (Aug 2026) | Comes from the registry gate protects. `sigstore@5` alone pulls 52 packages. ChainDrop ran its payload via Bun |
| Distribution | Static binary | Native binary | `bun build --compile` works, and Bun's docs call the output "still way too big" |
| Peer precedent | SCFW v4 moved from Python to Go for "a standalone, lightweight binary". osv-scanner, OSS Rebuild, AMPEL | pnpm 12, JSR | Verdaccio, vlt, Aikido Safe Chain, Socket sfw (Node SEA) |

Sources: [Sigstore conformance](https://sigstore.github.io/sigstore-conformance), [TUF conformance](https://theupdateframework.github.io/tuf-conformance/), [Tessera](https://github.com/transparency-dev/tessera), [Azul](https://github.com/cloudflare/azul), [cel-go](https://pkg.go.dev/github.com/google/cel-go/cel), [cel-js](https://github.com/marcbachmann/cel-js), [osv-scalibr extractors](https://github.com/google/osv-scalibr/tree/main/extractor/filesystem/language/javascript), [deps.dev semver](https://github.com/google/deps.dev/tree/main/util/semver), [Go checksum database](https://go.dev/ref/mod), [govulncheck](https://go.dev/blog/vuln), [arrayref incident](https://blog.rust-lang.org/2026/08/20/supply-chain-attack-on-arrayref/), [SCFW v4](https://github.com/DataDog/supply-chain-firewall/releases/tag/v4.0.0), [Bun executables](https://bun.com/docs/bundler/executables), [pnpm 12 in Rust](https://www.infoq.com/news/2026/09/pnpm-12-rust/).

*Opinion at the time:* Go for the core, because Tessera, osv-scalibr, sigstore-go, cel-go and AMPEL are all Go.

**Decision (2026-09-25): TypeScript.** The maintainer chose TypeScript. §11 has the stack that follows from that choice and the research behind it.

## 10. Reuse first, build the gaps

Rule: reuse unless a component fails on license (vs MIT), maintenance, its own supply-chain risk or a hard requirement.

| Role | Use | Why not build |
|---|---|---|
| Release-age gate | Client settings: npm `min-release-age`, pnpm `minimumReleaseAge`, Yarn `npmMinimalAgeGate`, Bun `minimumReleaseAge`. Dependabot `cooldown`, Renovate `minimumReleaseAge` | Already shipped in every client |
| Metadata quarantine proxy | Verdaccio (MIT) with a gate `allow_access` auth plugin, for teams already on Verdaccio | See the correction below |
| Malware and vuln data | OSSF malicious-packages, OSV.dev API | Apache-2.0, updated several times a day |
| Provenance and graph data | deps.dev API (caching permitted), npm attestations endpoint | Free, `verified` flag via sigstore-go |
| Rebuild evidence | OSS Rebuild public bucket (anonymous fetch works) | Popular packages only |
| Repo and workflow signals | Scorecard API, zizmor (`owner/repo@sha`) | Open, maintained |
| Static scan | GuardDog sidecar | Apache-2.0, Python |
| Sandbox results | OSSF package-analysis BigQuery dataset | Running the sandbox is expensive (200 replicas at 0.75-1 CPU in OSSF's own config) |
| Certificate format | in-toto + SLSA VSA (approved spec) | Records PASSED/FAILED, policy digest, input attestations |
| Policy evaluation | A CEL library inside gate (§11) | AMPEL checks one subject per CLI run, is Go-only, and its policies depend on its own CEL helper plugins. Keep it as a reference ([verify.go](https://github.com/carabiner-dev/ampel/blob/main/internal/cmd/verify.go), [policy guide](https://github.com/carabiner-dev/ampel/blob/main/docs/03-ampel-policy-guide.md)) |
| Log | Build a small tlog-tiles log in TS (§11) | Tessera ships no binaries or images, and its HTTP server is a conformance example with no auth |
| Client hooks | npm 12 `.npm-extension.mjs`, pnpm pnpmfile hooks, Yarn plugin hooks, Bun Security Scanner API | Official extension points. None of them runs on every install path (§11) |

Avoid: Aikido Safe Chain (AGPL), SCFW v4 (removed custom verifiers, now needs Datadog credentials), Socket Firewall (PolyForm Shield), pnpr (PolyForm Shield), vlt VSR (FSL), Nexus CE (EULA, 40k-component cap). Study only: pkggate and foxymirror (inactive since May 2026) and [npm-registry-firewall](https://github.com/antongolub/npm-registry-firewall) (MIT, zero dependencies, inactive since 2023-11).

**Correction to the first version of this section.** It said Verdaccio can't block single versions. The 6.10.4 code says otherwise:
- `@verdaccio/middleware` 8.1.4 reads the version from the tarball filename, and `@verdaccio/auth` 8.1.3 passes it to a plugin's `allow_access`. An auth plugin can deny one version.
- Since v6.4.0, `getTarball` also checks filter plugins, so a version removed from metadata returns 404 for its tarball. That check fails open: on a filter error it logs and allows. The docs and the package-filter README still say tarballs are unaffected, which contradicts the code.
- Sources: [storage.ts](https://github.com/verdaccio/verdaccio/blob/6862cd700b1a9e210c13bcff9d4ababe444b935e/src/lib/storage.ts), [@verdaccio/middleware](https://www.npmjs.com/package/@verdaccio/middleware).

What gate still builds:
1. npm evidence adapters and the graph walker. They turn a lockfile into per-version in-toto statements (publish time, trusted-publisher continuity, install scripts, feed hits). No reviewed tool produces these.
2. The versioned policy bundle in CEL, pinned by digest in the VSA `policy` field.
3. A small tlog-tiles decision log.
4. A per-package predicate. VSA has no field for per-node decisions.
5. A small proxy that owns the tarball decision. The Verdaccio plugin is an adapter, not the enforcement point, because the filter path fails open.
6. Thin client adapters for npm, pnpm, Yarn and Bun.

## 11. TypeScript stack

Researched 2026-09-25 after the maintainer chose TypeScript.

### Libraries

| Need | Choice | Facts | Source |
|---|---|---|---|
| Sigstore verification | `@sigstore/verify@4.1.2`, `@sigstore/bundle@5.0.0`, `@sigstore/tuf@5.0.0`. Not the `sigstore` umbrella (51 deps, includes signing) | 3, 1 and 10 transitive deps, Apache-2.0. Compose `getTrustedRoot` → `toTrustMaterial` → `Verifier.verify`, as `sigstore.createVerifier` does. Also check the statement subject against the tarball integrity, as pacote does. A test run verified `sigstore@5.0.0`'s own provenance on Node 22.23.2 and Bun 1.4.2. Rekor v2 bundles supported since 3.1.0. Engines: Node `^22.22.2 \|\| ^24.15.0 \|\| >=26` | [sigstore.ts](https://github.com/sigstore/sigstore-js/blob/main/packages/client/src/sigstore.ts) · [pacote registry.js](https://github.com/npm/pacote/blob/main/lib/registry.js) · [verify CHANGELOG](https://github.com/sigstore/sigstore-js/blob/main/packages/verify/CHANGELOG.md) |
| TUF | `tuf-js@6.0.0`, via `@sigstore/tuf` | MIT, 8 deps. Weekly tuf-conformance run with one expected failure (`test_artifact_cache`) | [conformance workflow](https://github.com/theupdateframework/tuf-js/blob/main/.github/workflows/conformance.yml) |
| package-lock.json | Hand-written parser with a schema | Plain JSON. `@npmcli/arborist` pulls 115 deps | deps.dev |
| pnpm-lock.yaml | `yaml@2.9.1` + a schema. `@pnpm/lockfile.types` as a devDependency | `yaml` has 0 deps. `@pnpm/lockfile.fs` pulls 68 | deps.dev |
| yarn.lock | `@yarnpkg/parsers@3.1.0` (`parseSyml` handles v1 and berry), or a hand-written v1 parser | 3 deps. `@yarnpkg/lockfile` hasn't had a release since 2018 | [syml.ts](https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-parsers/sources/syml.ts) |
| bun.lock | Hand-written, with `jsonc-parser@3.3.1` (0 deps) or a comment and trailing-comma stripper | JSONC. No published schema and no TS parser found. The example shows `lockfileVersion: 0`. Entries carry `sha512-` integrity | [bun.lock blog](https://bun.com/blog/bun-lock-text-lockfile) · [docs](https://bun.com/docs/pm/lockfile) |
| CEL | Pending. `@marcbachmann/cel-js@8.0.0` or `@bufbuild/cel@0.6.1` | cel-js: MIT, 0 deps, `check()` type-checking, parse-time limits, no runtime cost limit, no published conformance run. bufbuild: Apache-2.0, "Beta", runs the real cel-spec suite but skips several type-deduction groups, and pulls `@bufbuild/cel-spec` (6 MB unpacked). CEL is not Turing-complete. Only macros can blow up. Policies are canonical and local, not user-supplied, so a missing cost limit matters less | [cel-js](https://github.com/marcbachmann/cel-js) · [cel-es conformance](https://github.com/bufbuild/cel-es/blob/main/packages/cel/src/conformance.test.ts) · [langdef](https://github.com/google/cel-spec/blob/master/doc/langdef.md#performance-limits) |
| Schema | Pending. Effect Schema (v4) matches observed | `effect@4.0.0-rc.117` (2026-09-21) has no dependencies. Stable targeted for Q3/Q4 2026. A lockfile schema plus `decodeUnknownSync` bundled to 24.8 KB gzip in a test | [Effect 4.0 RC](https://effect.website/blog/releases/effect/40-rc) |

Roughly 17 packages in total, bundled into one file with no runtime dependencies.

### Runtime and distribution

- **Publish to npm as one Node-target bundle with zero runtime deps.** A test build of the verifier (`bun build --target=node --minify`) came out at 206 KB and ran in an empty directory.
- **Develop with Bun ≥1.4.1.** Bun's `crypto.verify` with EC keys was broken, which "silently breaks every Sigstore and TUF verification". It was fixed on 2026-08-28 and ships in 1.4.1 ([bun#40559](https://github.com/oven-sh/bun/issues/40559)).
- **Run CI on Node LTS and Bun.** One X509 bug is still open on Bun ([bun#31810](https://github.com/oven-sh/bun/issues/31810): `X509Certificate.ca` is true when basicConstraints is missing). Most npm users run the CLI under Node.
- **Skip compiled binaries for now.** `bun build --compile` produced an 81.3 MB hello world. A Node SEA binary will be at least the size of the node binary, which is about 125 MB locally ([Bun executables](https://bun.com/docs/bundler/executables), [Node SEA](https://nodejs.org/api/single-executable-applications.html)).

### Log

| Option | Verdict |
|---|---|
| Public Rekor v2 for every decision | No. v2 is still opt-in: the live Sigstore signing config lists only Rekor v1. No rate limits are published. The LF terms allow only "reasonable" use and allow suspension. Entries can never be removed. `sigstore.sign` in v5.0.0 still writes to v1 ([CLIENTS.md](https://github.com/sigstore/rekor-tiles/blob/main/CLIENTS.md), [LF terms](https://lfprojects.org/policies/hosted-project-tools-terms-of-use/), [sign CHANGELOG](https://github.com/sigstore/sigstore-js/blob/main/packages/sign/CHANGELOG.md)) |
| Tessera sidecar | Only if a Go build step in the image is acceptable. No prebuilt binaries or images, and `cmd/conformance/posix` is a test harness with no auth ([cmd](https://github.com/transparency-dev/tessera/tree/main/cmd)) |
| **Own tlog-tiles log in TS** | Yes. The five C2SP specs total about 6,800 words ([tlog-tiles](https://c2sp.org/tlog-tiles), [checkpoint](https://c2sp.org/tlog-checkpoint), [signed-note](https://c2sp.org/signed-note), [witness](https://c2sp.org/tlog-witness), [cosignature](https://c2sp.org/tlog-cosignature)). A single writer keeps it simple. Copy the inclusion-proof and checkpoint code from sigstore-js `packages/verify/src/tlog` (Apache-2.0, not exported). Use `@cloudflare/tlog-tiles-wasm` and `@cloudflare/signed-note-wasm` (BSD-3-Clause, verify-only) as test oracles, not runtime deps |

Witnessing works from TS because the protocol is plain HTTP. Joining witness-network.org means emailing the log's origin, Ed25519 key and a declared checkpoint rate. Going over the declared rate can get the log blocked ([participate](https://witness-network.org/participate/)). One idea to validate later: anchor the log's checkpoint in public Rekor once a day with a single entry.

### Client adapters: what each covers

| Client | Extension point | Blocks by | Misses |
|---|---|---|---|
| npm 12 | `.npm-extension.mjs` exporting `transformManifest` (since 12.0.0-pre.2) | Throwing (`ENPMEXTENSIONTHROW`) | `npm ci` doesn't run it. `ignore-scripts` disables it. Synchronous, manifests only ([docs](https://github.com/npm/cli/blob/latest/docs/lib/content/configuring-npm/npm-extension.md)) |
| pnpm 11/12 | pnpmfile `readPackage`, `afterAllResolved` | Throwing (`ERR_PNPM_PNPMFILE_FAIL`) | `--frozen-lockfile` never resolves, so the hooks don't run ([hooks lib.rs](https://github.com/pnpm/pnpm/blob/main/pnpm/crates/hooks/src/lib.rs)) |
| Yarn berry | Plugin `validateProject` (`reportError` → exit 1), `wrapNetworkRequest` (throw fails a fetch) | Error report or throw | `validateProject` runs before resolution and sees only the lockfile's existing packages ([Project.ts](https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-core/sources/Project.ts)) |
| Bun | Security Scanner API. `scan({packages:[{name,version,tarball,requestedRange}]})` | A `fatal` advisory, or throwing | Gets no integrity hash. Frozen installs appear to be scanned, based on reading the source, not a test ([security.d.ts](https://github.com/oven-sh/bun/blob/main/packages/bun-types/security.d.ts)) |

Frozen CI installs skip the npm and pnpm hooks, so **`gate verify` as a separate CI step stays required**. The hooks are an early warning on developer machines.

**Tested 2026-09-25.** The evidence notes were never committed; the results below and in AGENTS.md are the record:
- pnpm 11 and 12 hooks don't run for lockfile installs at all, frozen or not. On pnpm 12, `afterAllResolved` fails only after the package is already linked.
- Bun's scanner runs on every install path, including `--frozen-lockfile` and `bun ci`. It receives the tarball URL but no integrity. It must come from npm or a bunfig path, because local `file:` and `workspace:` scanners fail.
- A Verdaccio auth plugin must deny with `cb(err)`. `cb(null, false)` falls through to the default allow. Verdaccio's filename version parser gets some valid semver versions wrong.
- The Sigstore verifier accepts a valid bundle for the wrong package. gate must match the subject purl and sha512 to the packument itself.

### Hardening gate's own releases

- Publish with npm trusted publishing (npm ≥11.5.1, Node ≥22.14.0), which generates provenance. Set "Require 2FA and disallow tokens" ([docs](https://docs.npmjs.com/trusted-publishers/)).
- Use staged publishing (`npm stage publish`, npm ≥11.15.0), where a maintainer approves each release with 2FA ([docs](https://docs.npmjs.com/staged-publishing/)). Automation tokens should be stage-only ([docs](https://docs.npmjs.com/about-access-tokens/)).
- In gate's own repo, set Bun `minimumReleaseAge` and use `bun ci` or `bun install --frozen-lockfile` in CI. Frozen mode is not on by default. Keep `trustedDependencies` empty unless a dependency needs a script ([bunfig](https://github.com/oven-sh/bun/blob/main/docs/runtime/bunfig.mdx), [install](https://github.com/oven-sh/bun/blob/main/docs/pm/cli/install.mdx), [lifecycle](https://github.com/oven-sh/bun/blob/main/docs/pm/lifecycle.mdx)).

## Resolved questions

| Question | Answer | Source |
|---|---|---|
| Rekor v2 witnessing live? | Partly. The production checkpoint carries three witness cosignatures (geomys, stagemole, Google staging), but client quorum policy is still open. witness-network.org lists no production logs yet, and Rekor v1 stays the default "for the foreseeable future" | https://log2025-1.rekor.sigstore.dev/checkpoint · https://github.com/sigstore/rekor-tiles/issues/77 · https://blog.sigstore.dev/rekor-evolution/ |
| pnpm 12 runs pnpmfile hooks? | Yes. `readPackage`, `preResolution`, `afterAllResolved`, `updateConfig` run in Node workers. Only `filterLog` was dropped. Open regression: a non-string range from `readPackage` is dropped | https://pnpm.io/pnpmfile · https://github.com/pnpm/pnpm/issues/15705 |
| Can a pnpm hook abort an install? | Yes, by throwing, in both 11 and 12. Not on frozen installs | §11 |
| Which keys do clients trust behind a proxy? | npm checks only in `npm audit signatures`, and falls back to the proxy's `/-/npm/v1/keys`. pnpm install does no crypto: `trustPolicy` reads packument fields as served. pnpm `audit signatures` uses the registry's keys and skips provenance. Yarn and Bun verify nothing. **So gate is the only place provenance gets verified for pnpm, Yarn and Bun users, and a proxy can forge the fields pnpm `trustPolicy` relies on** | https://github.com/npm/cli/blob/latest/lib/utils/verify-signatures.js · https://github.com/pnpm/pnpm · https://github.com/yarnpkg/berry/issues/6487 · https://mondoo.com/blog/npm-supply-chain-security-package-manager-defenses-2026 |
| Does npm have an install hook? | Yes, since npm 12: `.npm-extension.mjs`. The first version of §10 said npm had none, which was wrong | §11 |
| Package Analysis cost? | No published figure. OSSF's config runs 200 workers, each requesting 750m CPU/768Mi (limit 1 CPU/2Gi). Not archived. Last release 2026-05-20 | https://github.com/ossf/package-analysis |
| Dafny Go backend ready? | No maturity label. Documented limits include all symbols exported and several unsupported features. Moot while the formal spec is deferred | https://dafny.org/latest/Compilation/Go |
| Signed packuments or TUF for npm? | npm/rfcs #76 "Signed Packuments" has been open since 2019. No TUF proposal found. Freshness stays gate's problem | https://github.com/npm/rfcs/pull/76 |
| Verdaccio license, tarball gating? | MIT for both. Per-version tarball blocking works through an auth plugin (§10 correction) | §10 |
| StepSecurity cooldown open source? | No, it's part of their paid platform | https://www.stepsecurity.io/blog/introducing-the-npm-package-cooldown-check |
| CEL or Cedar? | CEL. Cedar's principal/action/resource model fits per-package predicates poorly, and `@cedar-policy/cedar-wasm` is 13 MB without symcc | §11 |
| AMPEL at scale? | One subject per CLI run, Go only. Not used as gate's evaluator | §10 |
| OSS Rebuild without Google auth? | Yes. The `google-rebuild-attestations` bucket is public. ADC is needed only to verify KMS signatures | https://docs.oss-rebuild.dev/storage/ |
| Socket data for third-party tools? | No terms found that allow it. The terms pages return 403. The Threat Feed API needs an Enterprise plan with an add-on. Socket Firewall Free is PolyForm Shield, which bars competing products. Don't depend on Socket data | https://docs.socket.dev/reference/getorgthreatfeeditems · https://github.com/SocketDev/sfw-free/blob/main/README.md |
| osv-scalibr fields, go-tuf conformance | Moot after the TypeScript decision | none |

## Unresolved questions

- Resolved by testing on 2026-09-25: whether Bun's scanner runs on frozen installs (yes), the Verdaccio filename parser (four valid versions misparsed), and whether sigstore-js hits Bun's X509 bug (no).
- Resolved by decision: CEL through a cel-js fork ([§12](#cel-fork)), and Effect Schema v4 at rc.117 ([§12](#effect-v4)).
- Rekor v2 write limits, and whether a daily checkpoint anchor is worth it.
- Resolved 2026-09-25: the CLI uses `effect/unstable/cli` with `@effect/platform-bun`. The bundle also runs on Node ([§12](#effect-v4)).

## 12. Decisions

Accepted decisions. Each one holds until a later entry here replaces it. The first plan predates most of them.

### TypeScript

Accepted 2026-09-25. gate is TypeScript, not Go, even though the reusable Go libraries (Tessera, osv-scalibr, sigstore-go, cel-go) fit well. The maintainer works in TypeScript.

- gate implements its own tlog-tiles log, because no TypeScript library exists.
- The CEL evaluator is a fork (see [CEL fork](#cel-fork)).
- Bun must be ≥1.4.1. Earlier versions broke EC signature verification, which "silently breaks every Sigstore and TUF verification" ([bun#40559](https://github.com/oven-sh/bun/issues/40559)).

### Effect v4

Accepted 2026-09-25. Use Effect v4 as observed does, pinned to `4.0.0-rc.117`. Move to 4.0 stable once it ships.

The CLI uses `@effect/platform-bun`, and its bundle still runs on Node. Tested 2026-09-25: a CLI built with `bun build --target=node` using `BunServices.layer` read a file and printed `--help` under Node 22.23.2 and Bun 1.4.2. `@effect/platform-bun` depends only on `@effect/platform-node-shared`, and the bundle contains no `Bun.*` calls. This breaks if the CLI starts using a Bun-only service. Docs: [onboarding](https://effect.website/docs/v4/onboarding), [Schema](https://effect.website/docs/v4/api/effect/Schema), [CLI](https://effect.website/docs/v4/api/effect/unstable/cli/Command), [platform-bun](https://effect.website/docs/v4/api/platform-bun).

### CEL fork

Accepted 2026-09-25. Policies are CEL, evaluated by `packages/cel`, a fork of [`@marcbachmann/cel-js`](https://github.com/marcbachmann/cel-js) (MIT, license in `packages/cel/LICENSE`). It was forked from release `8.0.0`, commit `86cd97216a1cbb522eda81aaa0221c245d5913d7`, integrity `sha512-oaTrAziGr3zDLFiMt/yLU3nZuRMawyWQB5X1a0I7s9eGy3JYzX9l8ZXXHyMd64nzbeVFZTewuUShwsZQdK6UCA==`. To pull upstream changes, diff from that commit and port each change by hand. Consider sending the fixes upstream.

- cel-js is MIT, has zero dependencies and has a type checker. The alternative, `@bufbuild/cel`, is beta and pulls a 6 MB spec package.
- It's forked because the official cel-spec suite found wrong answers a policy engine can't accept, such as missed overflows and wrong `in` results, and upstream had been quiet since 2026-06-25.
- Source and tests are TypeScript, run with `bun:test`. The test helpers split into sync and `Async` variants.
- Fixed, each tested next to the feature it covers: int overflow on negation and `/ -1`, and `int()`/`uint()` range checks from double; repeated and invalid map keys, and input maps with an own `constructor` key; uint in `in` and `==`, and int/uint/double comparison after conversion to double; UTF-8 bytes literals, invalid UTF-8 in `string(bytes)`, and `bytes.json()` without `Buffer`; timestamp and duration ranges; field access on present primitive optionals; types registered on one environment leaking into every other environment; error messages for placeholder types, handler cache collisions, `async` on operators, `join()` on a Set, unregistered field types, and types named after `Object.prototype` members.
- Not fixed: timestamps are `Date`, so nanosecond arithmetic is lost. Map keys are stored as strings, so `{1: 'a'}['1']` returns `'a'`. Map literals drop `__proto__`, `constructor` and `prototype` keys (upstream asserts this); input objects keep them.
- Conformance (2026-09-26): `packages/cel/test/conformance-known-failures.json` lists the 1135 cel-spec cases that fail or are unsupported, with their kind. Every other case must pass, and a listed case that changes kind fails the test. `CEL_CONFORMANCE_UPDATE=1` only removes entries that now pass, and still fails on a regression. The list replaced a 2344-entry baseline, under which a newly added failing case counted as no regression. The same change fixed the harness: check-only cases ignored `check().valid`, so 9 cases passed without checking anything. 8 of them compare deduced types, which the harness doesn't do, so they are now `unsupported`, and 1 fails.

### Replay corpus

Accepted 2026-09-26. Fixtures in `packages/gate/test/replay/fixtures` hold per-version facts, not recorded packuments. npm removes the version document of a malicious release but keeps `time[version]`, so each incident's facts come from several sources. Every fixture lists them, along with the facts no source holds.

- A fact counts if a source recorded it: the packument, attestation endpoints, advisories, postmortems, public lockfiles, Wayback captures, Socket's archived file listings, the packages.ecosyste.ms mirror. An inference is not a fact, so provenance stays `unknown` for chalk 5.6.1 and tinycolor 4.1.1 although both were almost surely unsigned. `unknown` makes the policy quarantine, which is the honest reading of what's missing.
- History is the 10 versions published before the target, by `time`. Only versions at least 72h older than the target count as a baseline, so an attacker's own burst of releases can't vouch for the next one.
- A feed hit counts from the first `import_time` in the entry's `malicious-packages-origins`, not from `published`. OSV backdates `published` to the source advisory (chalk's MAL entry says 17:11Z, but the feed only had it at 00:35Z the next day), and entries gain versions after they're created.
- Each incident is evaluated at its first public report and one minute before takedown, using the earliest known bound when no exact takedown time exists. chalk has only an upper bound, npm's all-clear. The benign fixture is evaluated only before its capture date, because feed state after that is unknown.
- A fixture with a `miss` field records an incident the policy does not catch. The test asserts the miss, so a new signal that catches it forces the fixture to change. This is the same pattern as the CEL known-failures list.

Corpus: chalk 5.6.1, nx 21.5.0, @ctrl/tinycolor 4.1.1 (Shai-Hulud), @tanstack/react-router 1.169.5, event-stream 3.3.6, postmark-mcp 1.0.16 (miss), and vite 8.3.0 (benign). Reviewed and left out:

- ChainDrop keyv 6.0.0, Shai-Hulud 2, Bitwarden CLI, SAP CAP, @redhat-cloud-services, AsyncAPI and axios 1.14.1 repeat classes already covered: valid provenance from the usual workflow, a new install script, or a trust downgrade.
- shai_hulululud stayed up 71 days as a package's first publish, but its publisher, scripts and integrity are unrecoverable.
- node-ipc 12.0.1's gaps turn the publisher change into `publisher_unknown`, so it would prove nothing new.

What the corpus shows:

- The 72h window catches every incident taken down within 72h. TanStack is caught by nothing else.
- event-stream (78 days live) is caught only by `publisher_recent`.
- postmark-mcp (7.8 days) is not caught: the same publisher changed one line of code. Neither is a malicious first publish once 72h pass. Both need content analysis or a faster feed.
- TanStack's payload came through an injected git dependency (`github:tanstack/router#79ac49ee…`). `exotic_source` rejects that node once the lockfile walker exists. A new-dependency signal would also catch event-stream and axios; it needs the dependency graph too.

### SupplyChainPolicy/v1

Accepted 2026-09-26. v1 is frozen at `sha256:891f054d447051807bfa5cd6b7552b592fa01823dd116661f30019d270a1cb62`, pinned in `packages/gate/src/policies.ts`. Changes go into v2.

- **Publisher continuity** compares against every identity in the history, not only the previous version. npm allows up to 10 trusted-publisher configurations per package, and "evaluation order is not guaranteed". The config list needs maintainer auth to read. `_npmUser.trustedPublisher.oidcConfigId` is public, but a first-seen ID doesn't distinguish a new config from an old one that matched first. So identity is the provenance repository and workflow path, and the config ID is ignored.
- **A new workflow fires `publisher_changed` once.** Later versions from it are continuous. Adopting provenance on an established package is also a change, since a token thief can publish with provenance from their own repository. Only a package's first publish has no baseline. `publisher_recent` quarantines an account (token publishing) that joined an established package within 30 days before the publish. That is event-stream's staging pattern. A patient attacker beats it, as with any window.
- **Waivers** clear a waivable QUARANTINE rule for one exact package, version and integrity, with a reason, an author and a mandatory expiry. They follow JFrog Curation and Sonatype waivers; pnpm's `trustPolicyExclude` is by name or version without expiry. gate re-evaluates on every run, so an expired waiver re-flags the version. Only `trust_downgrade`, `publisher_changed`, `publisher_recent` and `new_install_script` are waivable: a reviewer can check those. A waiver names the policy whose rule it clears, so a canonical waiver can't clear an org rule with the same code. REJECT rules, evaluation errors, the age window and unknown evidence are not waivable. An urgent-fix lane for the window is separate work (gap 4 in §6).
- **Probabilistic claims.** v1 has no claims rule and no threshold. None of the reviewed systems blocks on a raw classifier score without human review. Amalfi flags about 1 in 1000 and sends every flag to a reviewer, and TypeSafe tells users to pick thresholds from their own data. An org that configures a classifier writes its own QUARANTINE rule with its threshold, which the log records through the org policy digest. REJECT rules can't read `claims`.
- **Exotic sources** are rejected unless an allowlist entry names the package and pins the content: a git spec ending in a full 40-hex commit (npm and pnpm ignore git integrity), a tarball URL with a sha512 that must match, or a `file:` path inside the repository. Branches, tags, short SHAs, and URLs without integrity fail to decode.
- **A rule that fails to evaluate counts at its own outcome**, tagged `failed` so it reads as an evaluation error, not a violation, and never waivable. This follows Kubernetes and Kyverno `failurePolicy: Fail`, which keep error and violation apart as Kyverno's reports do. A failing REJECT rule rejects, and a failing claims rule can only quarantine.
- **`integrity_unknown`** quarantines a registry version with no `dist.integrity`, so every ACCEPT is tied to bytes. The Bun scanner path, which gets no integrity, can't produce an ACCEPT.
- **Limits.** The install-script check compares commands, not the files they run, so a changed `bundle.js` behind an old command passes. History that has waited out the window counts even if it was quarantined.
- A policy that fails to load, or whose bytes don't match the pinned digest, is refused. Org rules are evaluated separately and the stricter outcome wins.

### SupplyChainPolicy/v2

Accepted 2026-09-26. v2 is v1 plus one REJECT rule, `integrity_mismatch`, pinned at `sha256:e864b25d5966d00fc634081b138203ac130d1fd6eddafa1f1374b4e5145aa2c1`. `gate verify` evaluates v2. The replay corpus runs under v1 and v2 with the same expected outcomes.

- Evidence gained `integrityCheck`. `matched` means the lockfile and `dist.integrity` agree, and the decision is tied to those bytes. `mismatched` means the lockfile pins other bytes, and v2 rejects. `unchecked` with a lockfile means one side has no sha512, so `source.integrity` is null and `integrity_unknown` quarantines. Without a lockfile (the replay fixtures) the packument integrity stands and the check is `unchecked`.
- `subject.version` is nullable. A git dependency declared in a lockfile edge has no version. Waivers can't match it.

### Lockfile replay

Accepted 2026-09-26. `packages/gate/test/verify` holds recorded lockfile fragments, a shared evidence directory, and the expected `gate verify` output per evaluation time. `evidence/SOURCES.json` labels every file.

- No public package-lock.json pins `@tanstack/react-router@1.169.5`. GitHub code search for the injected commit (2026-09-26) found one package-lock.json, `shoonyatech/shoonya.web@b59795e4`, committed during the attack. It pins 1.169.8, the other version in MAL-2026-3465, with the same `github:tanstack/router#79ac49ee…` optionalDependency. It has no node for `@tanstack/setup`, only the edge. That lockfile is the TanStack case. The other hits were scanner code, test fixtures, and one bun.lock (`whycarlindev/videoflow-app`), which is out of scope until the bun.lock parser exists.
- The vite 8.3.0 case is `camsong/You-Dont-Need-jQuery@d413b575`.
- Fragments keep the root entry and the target entries verbatim and drop the rest. Packuments keep the target and the 10 versions before it, with only the fields gate reads. `_npmUser` loses its email.
- Evidence is as of capture. npm removed 1.169.8's version document and attestation, so its integrity, provenance, publisher and scripts read as unknown. A run at the commit time would have seen them. The outcome class matches either way. The lockfile holds the only recorded digest of that tarball.

### package-lock parser

Accepted 2026-09-26. Hand-written with Effect Schema, v2 and v3 only. `@npmcli/arborist` pulls 115 packages (§11).

- A registry entry must resolve to its own name and version's tarball on registry.npmjs.org, the lockfile-injection check lockfile-lint does. Tarballs on other hosts, mirrors included, are `url` sources until `gate verify` takes a registry setting.
- An integrity with two different sha512 digests ties the entry to no bytes. ssri accepts a tarball matching any of them, so a second digest could admit other bytes.
- A declared git, URL or file dependency with no installed node becomes its own node, which is how the TanStack edge reaches the policy. A declared registry range without a node isn't checked, so a truncated lockfile passes for the entries it lacks.
- Bundled entries ship inside their parent's tarball and aren't nodes.

### Sigstore dependencies

Accepted 2026-09-26. Provenance is `verified` only when a bundle verifies offline against a recorded `trusted_root.json` and its subject matches.

- Added `@sigstore/verify@4.1.2` (certificate chain, SCTs, tlog inclusion, DSSE signature) and `@sigstore/bundle@5.0.0` (bundle parsing). Hand-writing X.509, CT and Rekor checks is the kind of code that fails open. Added `@sigstore/protobuf-specs@0.5.2` for `TrustedRoot.fromJSON`. It is already a dependency of both.
- Not added. `@sigstore/tuf` (10 packages) only fetches the trusted root, and offline mode reads a recorded one. It comes with network mode. `@sigstore/core` isn't a direct dependency because the verifier's `Signer` already carries the certificate extensions.
- Identity comes from the Fulcio certificate: Source Repository URI (1.3.6.1.4.1.57264.1.12) and the workflow path in Build Config URI (…1.18). The in-toto predicate is written by the workflow that signs it, so gate doesn't read identity from it. Only the GitHub Actions issuer is accepted. Other issuers are `unavailable`.
- The statement subject must equal `pkg:npm/<name with %40>@<version>` with the sha512 of `dist.integrity`. A valid bundle for another version, package or tarball is `unavailable`.
- Failure is always `unavailable` with a reason, never `absent`. An advertised attestation with no recorded bundle, no sha512 integrity, or no trusted root is `unavailable` too.

### @effect/platform-bun

Accepted 2026-09-26. Added at `4.0.0-rc.117` for the CLI, as the Effect v4 entry says. It installs `@effect/platform-node-shared`, `ws` and `@types/ws`. The Node bundle of `gate verify` contains no `ws` code and no `Bun.*` calls.

### gate verify, offline

Accepted 2026-09-26. Missing evidence never reads as clean.

- Install scripts of git, URL and file sources are always unknown. npm runs `prepare` when it builds a git dependency, and the lockfile's `hasInstallScript` doesn't cover that.
- An OSV snapshot needs `osv/manifest.json` with its capture time and the packages it covers, or `all` for a full clone of ossf/malicious-packages. Without it, feeds are unavailable: an empty or partial directory can't prove a package is clean. A package the manifest doesn't cover is unavailable, and so is every package once evaluation is more than 24 hours after capture. The feed updates several times a day, and 24 hours bounds how long a missed listing can go unnoticed. The manifest isn't bound to its record files, so a record deleted from the directory goes unnoticed. The directory is trusted input offline, and a signed snapshot belongs with network mode.
- A hit counts from the earliest `import_time` of an origin that lists the version, as in the replay corpus. gate evaluates version lists and ranges open from `0`. Any other range makes feeds unavailable for that package. A node without a version matches every entry for its name.
- History provenance needs a recorded bundle per earlier version, or that version's publisher reads as unknown.
- If the lockfile records `hasInstallScript` and the packument lists no install hook, scripts are unknown. A `gypfile` with no install hook counts as `node-gyp rebuild`, which npm runs.
- Provenance facts share the evidence's `kind` union. The replay fixtures moved to that encoding with the same facts, and their `unknown` provenance became `unavailable` with the reason "no source recorded it".
- `--context` supplies the allowlist and waivers (see [Decision context](#decision-context)). Without one, every git, URL and file node rejects, and so does every link that doesn't point at a declared workspace (see [Workspace links](#workspace-links)).

### Decision record

Accepted 2026-09-26. Each log entry is one `gate.decision/v1` record: node location, `dev` and `optional`, subject, evaluation time, the full evidence, the context, the lockfile's sha256, the policy refs, the outcome and the reasons.

- Bytes are RFC 8785 (JCS) canonical JSON in UTF-8: keys sorted by UTF-16 code units, no whitespace, ECMAScript number formatting, lone surrogates refused. The encoder is 45 lines in `src/canonical-json.ts`. JSON matches what `gate verify` already prints and needs no dependency. Deterministic CBOR (RFC 8949 §4.2) would need an encoder, and protobuf has no canonical form.
- A record reads only if re-encoding it gives the same bytes. Unknown fields, whitespace, another key order, or `20:14:12Z` for `20:14:12.000Z` make it unreadable, so a digest names one decision and one encoding.
- `subject` repeats `evidence.subject` so a reader can scan subjects without parsing evidence. Replay fails a record where they differ.
- The lockfile digest covers the file's bytes, not the parsed lockfile.
- Only decisions are logged. An unreadable lockfile node has no decision. `gate verify` still prints it and exits 1.

### Decision context

Accepted 2026-09-26. `gate verify --context <file>` reads `{"allowedSources": [...], "waivers": [...]}` with the schemas in `src/context.ts`. Both keys are required, and an unknown key fails the run, so a misspelled `waiver` can't silently drop waivers. Every record logs the context it was decided with.

### Decision log

Accepted 2026-09-26. `gate verify --log <dir> --log-key <file>` appends one entry per decision to a single-writer [tlog-tiles](https://c2sp.org/tlog-tiles) log on local disk: `checkpoint`, `tile/<L>/<N>[.p/<W>]` and `tile/entries/<N>[.p/<W>]`, as the spec lays them out.

- The checkpoint is an Ed25519 [signed note](https://c2sp.org/signed-note) with no extension lines. Its origin must equal the key name, where the spec only says SHOULD.
- Keys use the `golang.org/x/mod/sumdb/note` encoding that Tessera and the Go checksum database use: `PRIVATE+KEY+<name>+<id>+<key>` and `<name>+<id>+<key>`. C2SP defines only the verifier form. Key data can contain `+`, so parsers cut only the leading fields.
- An `O_EXCL` lock file keeps out a second writer. A crash leaves the lock, and gate fails until someone removes it rather than guessing it's stale.
- gate starts a log only in an empty or missing directory. Files without a checkpoint are refused, because starting over would sign a checkpoint inconsistent with an earlier one, which tlog-checkpoint forbids.
- Before appending, the writer checks the level 0 tiles against the checkpoint root and the partial bundle against its tile, re-reading every level 0 hash. That's linear per run and fine at M1 volumes. A corrupted full tile above level 0 is caught only by replay.
- Files are written to a temporary name, fsynced, renamed, and their directories fsynced, with the checkpoint last. Tiles a crash leaves behind are past the checkpoint, and the next append overwrites them (tested).
- The log is written before stdout, so a failed append prints no verdicts and exits 1.
- Entry bundles use uint16 lengths, so a record over 65,535 bytes fails the run. TanStack records are about 1.8 KB.
- Inclusion verification is ported from sigstore-js `packages/verify/src/tlog/merkle.ts`, and note parsing follows its `checkpoint.ts`, both at `769a53d8`, with the Apache-2.0 notice and changes listed in each file. sigstore-js matches signature names by substring. gate requires the name and computed key ID to match.

### Log test oracles

Accepted 2026-09-26. Added `@cloudflare/tlog-tiles-wasm@0.2.0` and `@cloudflare/signed-note-wasm@0.2.0` as devDependencies for tests only. Both are BSD-3-Clause, with no dependencies or install scripts, and trusted-publisher provenance from `cloudflare/azul`. They were published 2026-08-21 and had no OSV or GitHub advisories on 2026-09-26.

- The signed-note oracle verifies checkpoints written by `appendToLog` and by `gate verify`, and the tlog-tiles oracle parses them.
- tlog-tiles-wasm has no inclusion verification or tile reader. The tests check gate's tiles through consistency proofs the oracle verifies, and inclusion proofs and roots against the transparency-dev vectors in `test/log/rfc6962-vectors.json`.

### gate replay

Accepted 2026-09-26. `gate replay --log <dir> --public-key <file>` runs offline, with no evidence directory.

- The checkpoint needs a valid signature matching the key's name and ID. A same-name checkpoint from another key is refused, as signed-note requires.
- Every entry is proven against the checkpoint root from the tiles. A missing bundle or tile fails the entries it covers.
- A record must name one pinned policy (v1 or v2) by digest and id. An unknown digest or a second policy fails, because org policies aren't pinned.
- gate reruns `decide()` with the logged evidence, time and context, and compares the canonical bytes of outcome, reasons and policies. It prints one JSON line per entry (`match`, `mismatch` or `failed`) and exits 0 only if all match. A signed empty log exits 0, since only the key holder can sign one.
- Replay shows a decision follows from its logged evidence. It can't show the evidence was right. That needs the recorded packuments and bundles, which the log doesn't hold.

### License

Accepted 2026-09-26. gate is MIT, the maintainer's default, replacing the first plan's Apache-2.0. The hosted service, if built, is separate closed code. Everything needed to check a decision stays MIT.

- `packages/gate/src/log/merkle.ts` and `packages/gate/src/log/note.ts` stay Apache-2.0, as ported from sigstore-js, which has no NOTICE file. The root LICENSE carries the Apache text and names both files. Apache §4 allows this inside an MIT project ([Apache FAQ](https://www.apache.org/foundation/license-faq.html)).
- Apache-2.0 would add a patent grant and remove the mixed-license note. That wasn't worth changing the default for a CLI with no patents at stake.
- No AGPL or FSL. Both protect a hosted business by restricting the code, and the relicensing fights at Redis, Elastic and HashiCorp came from changing license after adoption. The license is set before launch.

### Network mode

Accepted 2026-09-26. `gate verify --lockfile <file> --fetch <cache-dir>` fetches live evidence into `<cache-dir>/evidence`, then verifies against that directory exactly as `--evidence` does. Passing both fails. Passing neither fetches into the per-user cache (see [Zero-config run](#zero-config-run)). `gate verify --evidence <cache-dir>/evidence --at <time>` reruns a fetch-mode run offline, and on the microsoft/vscode run below it gave the same 1,659 decisions.

- Each run rebuilds `evidence/` from the cache and writes `SOURCES.json` with each file's URL and fetch time and every failed fetch. Fetch times stay there. The decision record is unchanged.
- A packument is reused while the registry's `max-age` holds (300 s on 2026-09-26), then revalidated by ETag. If the refresh fails, the packument is left out, because a stale copy would hide a version npm removed. A cache entry stamped later than now counts as stale, so a cache restored from a runner with a fast clock can't stay fresh.
- Packuments cost one request per name. Attestations cost one request per version: the target and those of its 10 earlier versions that advertise provenance, because `publisher` compares against their verified identities. The vscode run fetched 1,169 packuments and 904 bundles. Bundles are cached for good.
- Packuments keep only the fields gate reads. A value of the wrong shape is kept as is, and all scripts stay, so a trimmed packument decodes exactly as the full one (tested on `ms`). Dropping a malformed non-install script would make an unreadable version readable.
- Every failed fetch is a gap and reads as unknown or unavailable, never clean. 429 and 503 are retried after `Retry-After`, read as delta-seconds or an HTTP date ([RFC 9110 §10.2.3](https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3)), and a wait over a minute fails instead. npm documents no registry rate limit.
- `--at` still works with `--fetch`. The snapshot can then be newer than `at`, which the offline rules already allow, since the lockfile cases evaluate before their capture.
- Requests go to registry.npmjs.org, codeload.github.com and tuf-repo-cdn.sigstore.dev. None carries the lockfile or a dependency list.
- Measured 2026-09-26 on this machine, Node 22.23.2, cold then warm: camsong/You-Dont-Need-jQuery@d413b575 (99 nodes) 15.2 s and 5.6 s. npm/cli@0c3b82a9 (899 nodes) 19.3 s and 7.8 s. microsoft/vscode@fb6287cc (1,659 nodes) 32.9 s and 11.0 s. Of vscode's warm 11.0 s, 7.0 s is the offline verify, mostly checking Sigstore bundles.

### Malware feed snapshot

Accepted 2026-09-26. Network mode downloads `https://codeload.github.com/ossf/malicious-packages/tar.gz/refs/heads/main` and reuses it for an hour.

| Source (2026-09-26) | Download | npm records | `import_time` |
|---|---|---|---|
| ossf/malicious-packages tarball | 45.8 MB gzip, 458 MB unpacked, 9.9 s | 221,947 (malicious and withdrawn) | Kept |
| OSV `npm/all.zip` | 216.7 MB, 7.6 s | 221,947 MAL plus 7,469 GHSA | Kept (MAL-2026-3465 matches the API) |

- The tarball is a fifth of the size and is the source OSV imports from ([OSV data docs](https://google.github.io/osv.dev/data/)). `git archive` stores the commit ID in the pax header and stamps every entry with the commit time ([git-archive](https://git-scm.com/docs/git-archive)). The manifest records the URL, the commit and `committedAt`. `capturedAt` is the download time.
- GitHub says branch archives are "generated on request, cached for a while" and recommends a commit ID for stable contents ([docs](https://docs.github.com/en/repositories/working-with-files/using-files/downloading-source-code-archives)). So the archive can be older than its download time, and `committedAt` shows by how much. Upstream went more than 24 h without a commit twice between 2026-08-13 and 2026-09-26 (30.9 h from 2026-09-12, 28.8 h from 2026-09-19).
- Parsing every npm record takes about 2 s on Node and Bun. gate matches records on `affected[].package.name`, not the directory. 103 records sit in a lowercased directory (`adultjs/` holds AdultJS).
- `osv/` gets only the records for the lockfile's names, and the manifest lists those names as covered. Any npm record that isn't JSON or names no affected package makes the whole feed unavailable, like an unreadable record offline. So does a repeated id among the kept records, an archive with no npm records (a moved directory would otherwise read as a clean feed), and a truncated archive, which the next run downloads again. The download may take up to 10 minutes.
- 39,866 npm records (18%) had `"malicious-packages-origins": null`, which the offline schema rejected. One of them made the whole snapshot unavailable, so a lockfile holding AdultJS got `feeds_unavailable` (QUARANTINE) instead of `feed_match` (REJECT). The schema now reads null as no origins, and the hit counts from `published`, as for a record with no origins. Upstream documents the field only as an array for internal use ([schema_additions.md](https://github.com/ossf/malicious-packages/blob/main/docs/schema_additions.md)), and no issue explains null. `published` can predate the feed: AdultJS's record says 2025-08-14, but its only commit is 2025-08-19, so a replay between those dates counts a hit the feed didn't have yet.
- The README moves partial false positives into a `database_specific` array, with handling "TBC". No npm record carried one on 2026-09-26, and gate doesn't read it.
- No official limit for codeload archives exists: GitHub's [2025-05-08 changelog](https://github.blog/changelog/2025-05-08-updated-rate-limits-for-unauthenticated-requests/) and archive docs don't mention them, and OSV's data docs state no limits either. If the download is refused, the feed is unavailable and every node quarantines on `feeds_unavailable`. OSV's `modified_id.csv` is the documented way to update a copy incrementally.

### @sigstore/tuf

Accepted 2026-09-26. Added `@sigstore/tuf@5.0.0` for network mode's trusted root, as §11 planned. It brings `tuf-js@6.0.0`, `@tufjs/models@5.0.0`, `@tufjs/canonical-json@2.0.0` and `@gar/promise-retry@1.0.3`, plus `debug`, `ms`, `minimatch` and its two dependencies. None has an install script or an OSV advisory (checked 2026-09-26). `@sigstore/tuf` 5.0.0 was published 2026-06-01 with provenance. A hand-written TUF client would re-implement root rotation, rollback and freeze checks, and getting those wrong would let an attacker pin gate to an old trusted root. `getTrustedRoot` ran on Node 22.23.2 and Bun 1.4.2, taking 0.4 to 0.8 s with a warm cache. If it fails, `trusted_root.json` is left out and provenance reads as unavailable.

### Zero-config run

Accepted 2026-09-26. `gate verify` with no flags reads `./package-lock.json` and fetches into a per-user cache, as `--fetch <cache>` would. It prints the same lines as that explicit run, apart from the evaluation time `at`.

- Updated 2026-09-26 for pnpm. It reads whichever of `./package-lock.json` and `./pnpm-lock.yaml` exists. With both, it fails before fetching and asks for `--lockfile`. No official source says which file a repository installs from, and preferring one would let the other hide a dependency. With neither, it fails before fetching. `--lockfile` takes the format from the name (`.json`, or `.yaml` and `.yml`), then from the content: a file starting with `{` is a package-lock.

- The cache follows each platform's documented location: `XDG_CACHE_HOME` or `~/.cache` ([XDG Base Directory 0.8](https://specifications.freedesktop.org/basedir/latest/)), `~/Library/Caches`, which Apple says holds "cached data that can be regenerated as needed" ([macOS Library directories](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/MacOSXDirectories/MacOSXDirectories.html)), and `%LOCALAPPDATA%`, defaulting to `%USERPROFILE%\AppData\Local` ([KNOWNFOLDERID](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid)). Apple suggests a bundle identifier as the folder name, which a CLI doesn't have. pip uses `~/Library/Caches/pip` ([pip caching](https://pip.pypa.io/en/stable/topics/caching/)) and Go's `os.UserCacheDir` tells callers to add "their own application-specific subdirectory" ([Go os](https://pkg.go.dev/os#UserCacheDir)), so gate uses `gate`. All checked 2026-09-26.
- npm's cache, `~/.npm` or `%LocalAppData%\npm-cache` ([npm config](https://docs.npmjs.com/cli/v11/using-npm/config#cache), checked 2026-09-26), ignores XDG, so gate doesn't copy it. `@sigstore/tuf` 5.0.0 defaults to a data directory (`dist/appdata.js`). gate keeps passing `<cache>/tuf`, so clearing gate's cache resets TUF's rollback state to the embedded root, as on a first run.
- A CI job restores its cache from an earlier run, so its warm run revalidates every packument (max-age 300 s) and downloads the feed again once the hour is up. Measured 2026-09-26 on Node 22.23.2, npm/cli@0c3b82a9 (883 nodes) took 7.8 s with a fresh cache, 12.4 s with stale packuments and 18.4 s with the feed stale too. The offline verify was 4.4 s of each.
- Verify time grows with attested versions, not nodes, because each node checks its own bundle and up to 10 earlier ones. In a CPU profile of opentelemetry-js@547bff40 (1,685 nodes, 2,867 checks), certificate-chain verification in `@sigstore/verify` took 14.7 of 17.0 s. Only 10 to 15% of the checks repeated a version, so caching within a run wouldn't help much. The PLAN target stays per node because nodes are what a user sees. There's no separate target for larger repositories. The M2 study records nodes, provenance checks and wall time for all 10.
- Two runs sharing the cache can replace `evidence/` under each other. From reading `collect.ts`, the losing run's packages then read as unknown or unavailable, never clean. Not tested.

### Workspace links

Accepted 2026-09-26. A link to a declared npm workspace isn't a node, like the workspace folder entry it points at. SupplyChainPolicy/v2 is unchanged.

- gate follows the way npm reads workspaces from a lockfile. Arborist 10.0.3 (npm/cli@0c3b82a9) writes a link as `{resolved: <path from the root>, link: true}` in `shrinkwrap.js`, and `load-virtual.js` maps workspaces with `mapWorkspaces.virtual` from `@npmcli/map-workspaces` 6.0.0. That matches `packages[""].workspaces` against lockfile keys with minimatch and names each one `name || nameFromFolder(key)`. npm's docs cover only `link`, `resolved` and "an array of file patterns" ([package-lock.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json), [package.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#workspaces), checked 2026-09-26).
- gate is stricter than npm. It matches a subset of minimatch, checked rule by rule against `mapWorkspaces.virtual` with minimatch 10.2.5 on 2026-09-26, and any pattern outside the subset passes no link. A workspace folder that is itself a link, or a name two folders share, also passes no link. Every link that doesn't pass rejects as before.
- A derived context doesn't work under v2. Allowing each link stops `exotic_source`, but v2 quarantines every non-registry node on `install_scripts_unknown`. On npm/cli@0c3b82a9 the 16 links went from REJECT to QUARANTINE, so no workspace repository could exit 0. A workspace is the repository's own code, and gate doesn't decide the root package either.
- A link entry outside `node_modules` is unreadable. None of the four repositories below has one, and `npm ci` 12.1.0 fails on one that the root declares. Other entries there that nothing points at are skipped, as before. npm before arborist commit 4c7f6baf7 (first tagged v12.0.0-pre.0 on npm/cli's main branch) leaves them behind with `extraneous: true` after a `file:` dependency or workspace is removed. In probes on 2026-09-26, `npm ci` 10.9.8 and 12.1.0 (with `--dangerously-allow-all-scripts`) installed nothing and ran no script for either kind of entry, while a declared `node_modules` link to the same folder ran its postinstall.
- The cost: the npm adapter makes this call, not the policy. A policy can't reject a workspace link, and a change to the matcher changes outcomes under the same policy version. Skipped links aren't logged. Their dependencies still are.
- Measured 2026-09-26: every link in npm/cli@0c3b82a9 (16), sigstore/sigstore-js@769a53d8 (14), open-telemetry/opentelemetry-js@547bff40 (49) and lerna/lerna@752bdbba (3) matched. Their REJECTs went to zero and every other decision stayed byte for byte the same.

### Policy invariants

Accepted 2026-09-26. The decision rules from AGENTS.md and policy v2 get an exhaustive test over every combination of evidence kinds, run against v2 and each later version:

- a feed hit or an integrity mismatch rejects;
- unknown evidence never accepts: an unavailable feed, unknown install scripts, and for registry sources unavailable provenance, an unknown publisher or publish time, or no integrity. Unknown earlier provenance counts only when this version has no provenance, as v2 intends;
- a registry version younger than the window never accepts;
- a claim only moves ACCEPT to QUARANTINE;
- a waiver clears only a waivable QUARANTINE rule;
- a non-registry source never accepts without an allowlist entry.

A scratch probe, not committed, ran 174,960 v2 decisions in 1.2 s on Bun 1.4.2 and found no violations. It caught two weakened copies of v2: one without `feeds_unavailable`, and one with `release_age` waivable. It missed a 24 h window until the probe also tested ages just under and at 72 h, so every duration rule needs cases on both sides of its threshold. The claims rule also holds by construction, because a REJECT rule that reads `claims` fails to load.

### Bend, revisited

Accepted 2026-09-26. Still no Bend (D5). Bend 2.0.29 ([bendlang/bend](https://github.com/bendlang/bend), archive checked against the sha256 in bend-lang.com's install script) checked a model of the decision with four laws in 0.11 s. It rejected a variant where a claim turns ACCEPT into REJECT. Against using it now:

- It proves a model, not the CEL policy gate runs. Using it needs a translation kept in sync with each policy.
- The guide shipped in the release says `bend2/bend.lean` lags `bend.ts`. Checker soundness bugs and checker-backend mismatches were fixed during September 2026 ([#1001](https://github.com/bendlang/bend/issues/1001), [#808](https://github.com/bendlang/bend/issues/808), [#954](https://github.com/bendlang/bend/issues/954), [#793](https://github.com/bendlang/bend/issues/793), [#878](https://github.com/bendlang/bend/issues/878)). [bend-lang.com](https://bend-lang.com/) says "Expect bugs".
- A law resting on an `@unsafe` or foreign def prints a note and exits 0. `cli_report` in `bend2/main.ts` treats those defs as promises by design, so CI would have to read the output.
- A law that calls implementation code can pass a bug. The first version of the claim law did.

Replay answers a different question: did this logged decision follow from its logged evidence. It stays. The exhaustive test in [Policy invariants](#policy-invariants) covers the laws against the real policy. Revisit Bend when the Lean model matches the checker, an unsafe-backed law fails the exit code, and a CEL-to-Bend translation exists.

### Human output

Accepted 2026-09-26. `gate verify` prints a report for people, with or without a terminal. `--json` prints what it printed before, byte for byte, and exit codes don't change.

- The format ignores the TTY, as npm, pnpm and osv-scanner do. `npm audit` picks its reporter from `--json` alone (`lib/commands/audit.js`, npm v11.20.0). pnpm's audit and outdated commands switch only on `--json` or `--format` (`crates/cli`, pnpm v12.6.0). osv-scanner prints its table on a terminal or not and only drops color and borders ([output docs](https://google.github.io/osv-scanner/output/), `internal/output/table.go`, v2.6.0). A pipe that switched to JSON would make `gate verify | less` unreadable. The GitHub runner redirects a step's stdout (`src/Runner.Sdk/ProcessInvoker.cs`, runner v2.337.0), so CI logs get the plain report and the Action should pass `--json`. No docs.github.com page says whether a step's stdout is a TTY. All checked 2026-09-26.
- Color needs a TTY or `FORCE_COLOR`. On a pipe or file `process.stdout.isTTY` is undefined on Node v24.21.0 (`lib/internal/bootstrap/switches/is_main_thread.js`) and Bun 1.4.2 (`src/js/builtins/ProcessObjectInternals.ts`). gate reads `FORCE_COLOR` as [Node documents it](https://nodejs.org/docs/latest-v24.x/api/cli.html#force_color1-2-3): `''`, `1`, `true`, `2` or `3` turn color on even with `NO_COLOR`, and any other value turns it off. [force-color.org](https://force-color.org) disagrees on `''` and `0`, and gate follows the runtime. A non-empty `NO_COLOR` ([no-color.org](https://no-color.org)) or `TERM=dumb` (Node's `lib/internal/tty.js`) turns color off. Checked 2026-09-26.
- Package data is escaped before gate adds color, so it can't forge gate's lines. `--json` isn't escaped further. `JSON.stringify` passes C1 and bidi controls through, but escaping them would change its bytes.
- Next steps don't change decisions, records or the log. `release_age`'s clear time comes from rerunning `decide()` at later times on the same evidence, so the window stays in the CEL rule. Printed waivers have TODO text for `reason` and `author`, which still decodes, so a waiver pasted unedited works.
- A lockfile entry with no sha512 stays that way. With npm 10.9.8, `npm install --package-lock-only` kept a missing integrity and a sha1-only one, and recorded the sha512 once the entry was removed and relocked (probed 2026-09-26 on `ms@2.1.3`). No npm doc says what npm does here. npm/cli@0c3b82a9 and sigstore-js@769a53d8 have 584 and 811 such entries.

### pnpm-lock parser

Accepted 2026-09-26. gate reads `pnpm-lock.yaml` with `lockfileVersion: '9.0'`. Any other version is unreadable, so pnpm 7 and 8 files (`5.4`, `6.0`, `6.1`) are too. The latest release of each line on npm on 2026-09-26 writes `9.0`: pnpm 9.15.9 and 10.34.5 (`packages/constants/src/index.ts`), 11.27.1 (`pnpm11/core/constants`) and 12.6.0, the Rust rewrite (`pnpm/crates/package-manager/src/dependencies_graph_to_lockfile.rs`). pnpm 12 also accepts `12.x` on read (`pnpm/crates/lockfile/src/lockfile_version.rs`), but no release writes it. Named-registry keys (`foo@work:1.0.0`) came without a version bump (`.changeset/named-registries-lockfile-format.md`). Sources read at each tag's source archive on 2026-09-26.

- Each `snapshots` key is a node, joined to its `packages` entry with pnpm's `removeSuffix` (`pnpm11/deps/path`). Peer variants are separate nodes, as separate install locations are in package-lock. The key is the node's `path`.
- The resolution decides the source. `{integrity}` alone is a registry node, and a missing or non-sha512 integrity is null, so it quarantines on `integrity_unknown`. A tarball on registry.npmjs.org must be the entry's own. codeload, bitbucket and gitlab archives and `type: git` are git sources and must pin a 40-hex commit, or the entry is unreadable. A codeload archive's spec is `github:<owner>/<repo>#<commit>`, so a context can allow it. Other tarball URLs are url sources, and `file:` tarballs and directories are file sources. `binary`, `variations` (pnpm's own Node.js runtime), `custom:` and unknown types are unreadable, and so are `revision`, a subdirectory `path` and named registries other than `npmjs:`.
- pnpm 11 merges a packages entry into its snapshot with `Object.assign` (`pnpm11/lockfile/fs/src/lockfileFormatConverters.ts`), while pnpm 12 ignores snapshot fields under `packages`. An entry with fields in the wrong section is unreadable.
- pnpm 9 dropped the dev flag, so gate computes dev and optional from the importer groups, as npm does. On the five recorded lockfiles, optional equals the flag pnpm writes on every production snapshot.
- pnpm 11 and 12 write an env document first, with `configDependencies` and `packageManagerDependencies` (`pnpm11/lockfile/fs/src/yamlDocuments.ts`). Its nodes are decided too, with paths starting `env:`. pnpm 10 keeps config dependencies in `pnpm-workspace.yaml` (`config/deps-installer/src/resolveConfigDeps.ts`), which gate doesn't read.
- With `excludeLinksFromLockfile: true`, pnpm leaves non-workspace links out and reads them from package.json at install (`pnpm11/installing/deps-restorer/src/index.ts`). gate adds an unreadable node.
- Catalogs, overrides and pnpmfile hooks change what resolves. The result is in importers and snapshots, which gate reads.
- Measured 2026-09-27 on 29 public lockfiles fetched at HEAD (vite, vue, nuxt, astro, pnpm and others): all read. The one unreadable entry is pnpm/pnpm's Node.js runtime. Parsing took 41 to 722 ms.

### Patched packages

Accepted 2026-09-26. A patched snapshot stays a registry node. Its packages entry and integrity describe the published tarball, and every registry check still applies to those bytes. The patch is a file in the repository, reviewed with the rest of its code, like a workspace. patch-package leaves no trace in package-lock, so a package-lock repository patching the same package gets the same decision. The path keeps `(patch_hash=…)`, so the log shows the node was patched.

The cost: a patch can add code or an install script, and gate neither reads the patch nor checks its hash.

### pnpm workspace links

Accepted 2026-09-26, mirroring [Workspace links](#workspace-links). A `link:` to an importer inside the lockfile's folder isn't a node. Neither is an injected workspace package, a `directory` resolution naming such an importer. pnpm lists importers from `pnpm-workspace.yaml`. Every other link is a file source and rejects: one that leaves the lockfile's folder through `..` or an absolute path, and one to a folder no importer names. Importer links resolve from the importer's folder, snapshot links from the lockfile's (pnpm 11.27.1 `installing/deps-restorer/src/index.ts` and `installing/deps-installer/src/install/link.ts`).

- gate takes the lockfile's folder as the repository. The rules_js lockfiles keep their importers in `../projects`, so each of their workspace links rejects.
- In the 29 lockfiles, links to folders no importer names reject: nitro 1, rolldown 2, trpc 1, drizzle-orm 13, vitest 10. vite's 110 injected packages all name importers.

### yaml

Accepted 2026-09-26. Added `yaml@2.9.1` for pnpm-lock.yaml. Published 2026-09-11 by its only maintainer, eemeli, with no dependencies, no install script and no provenance. OSV and GitHub list no advisory for it (the stack overflow in GHSA-48c2-rrv3-qjmp was fixed in 2.8.3). Checked 2026-09-26.

- A hand-written reader came first. 279 lines matched Bun.YAML on all 29 lockfiles, but none of them has a double-quoted or literal block scalar, and pnpm's emitter writes both (`pnpm/crates/lockfile/src/yaml_emit/scalars.rs`). Escapes, chomping and indentation indicators are where a hand parser drifts from js-yaml (pnpm 9 to 11) and serde-saphyr (pnpm 12), and any drift lets a lockfile say one thing to pnpm and another to gate.
- `src/yaml.ts` refuses anchors, aliases, tags, merge keys, directives, extra documents, duplicate or non-string keys, and folded or multi-line scalars. js-yaml honours merge keys and aliases, so each could change a node's meaning. Line breaks inside a flow collection only separate entries, so they're allowed. prettier writes them, and a prettier-formatted lockfile reads the same.
- The Node bundle grows from 1.17 to 1.42 MB unminified.

# Pull request risk tiers

The pilot classifies **every PR**, including agent-authored PRs, from the complete
changed-file list. Packages are not permanently assigned a risk level: the highest
applicable rule determines the PR's minimum tier. Unmapped apps and packages default to tier 2.
Existing CI, CODEOWNERS, and human approval requirements remain in place.

| Tier         | Classification                                                                                                                                                  | Review policy                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 0 - Trivial  | Every path matches a story or package-local documentation allowlist; no snapshots or protected paths                                                            | Option B: one human approval, using the AI summary as a map, not a substitute |
| 1 - Low      | Package tests/snapshots only, or at most 50 added plus deleted lines in one package's `library/src/` (or `packages/web-components/src/`), change files excluded | AI review followed by one human; fast-lane candidate                          |
| 2 - Standard | Everything else, including mixed changes that do not qualify for the fast lane                                                                                  | Existing human review plus applicable specialists                             |
| 3 - High     | Any protected path, including either side of a rename                                                                                                           | Owning team per CODEOWNERS; AI comments only, never AI approval               |

The tier comes from changed paths and line counts only. The title, description and
author are never read: they are the author's own words. Classification order:

1. Any listed protected path, on either side of a rename, is tier 3.
2. An empty or truncated file list (GitHub lists at most 3,000 files) is tier 2: the
   change cannot be judged.
3. A file without a text diff (binary, or too large for GitHub to show), other than a
   test snapshot, is tier 2: a renamed binary may have changed bytes even with zero
   added/deleted lines.
4. Tier 0, then tier 1; everything else is tier 2.

The tier 1 line budget counts additions and deletions, not net lines, including tests;
Beachball change files do not count. Only `library/src/` (v9 React and charts packages)
and `packages/web-components/src/` qualify: other `src/` folders belong to tooling,
legacy v8 or core runtime packages. A change file keeps docs and stories out of tier 0,
but does not disqualify tier 1. Tests and snapshots can accept regressions and never
qualify as trivial. Dependabot changes touch `package.json`, `yarn.lock` or `.github/**`,
so they are tier 3 by path; continue using `/dependabot-rollup`.

## Deterministic enforcement

[The map](../../.github/risk-tiers.json) has two lists: `trivial` (every changed path
must match one) and `protected` (any match is tier 3). Keep `trivial` to at most 15
paths and never add a broad `**/*.md` rule: agent instructions must not enter the fast
lane. Both lists use one matcher that supports literal paths plus `*` and `**`;
unsupported pattern syntax fails explicitly instead of silently weakening a rule.
Wildcards match hidden names, so a protected directory covers its hidden files, while
hidden files never count as trivial. Protected globs ignore case, so `agents.md` counts as
`AGENTS.md`; `AGENTS.override.md` is protected alongside it. Trivial stories are the
package-level `stories/src/` folders only, and configuration files (`*.config.*`) never
count as trivial. Tier labels and criteria are defined once, in `risk-tiers.js`; the model
receives the same criteria.

The classifier is the only writer of the four mutually exclusive `Risk:` labels,
enforcing precedence and exclusions, then applying any model escalation. The area
labeler runs in its own job with its own permissions, does not publish risk labels,
and does not depend on the pilot. It considers old and new
filenames for renames. An incomplete file list is labeled tier 2; API errors fail
the workflow rather than certify a tier. The `PR risk assessment` check is attached to the classified head
SHA. In this label-only pilot it always succeeds once classification finishes; for tier 2/3 it
reminds the author to add a nonempty `Review focus: ...` line (a list bullet and bold are
accepted). The check's `text` holds one JSON record per assessment (final, deterministic and
model tier, confidence, mode, review focus present) for measuring the pilot.
The description should identify API/consumer contracts, intent/design, accessibility,
or trust boundaries that need human attention. Authors verify every claim and report
real evidence, or explicitly say "not run".

The `pull_request_target` job only executes base-branch code and reads PR metadata
through the GitHub API. It never installs dependencies, evaluates PR content as code, or
checks out the head. Changes to the map or classifier take effect after merge, not on the
PR proposing them. Its first step, before any fallible setup, creates an in-progress
`PR risk assessment` check on the current head, so an outdated result never stays
visible; an `always()` finalizer fails that check if setup, classification or
cancellation stops it. Runs are serialized per PR without cancelling the active run, and
a run for a superseded head exits without creating a check. The classifier verifies the
head before it starts and re-reads the PR before labeling: if the head, base or
description changed meanwhile, it fails the check instead of publishing an outdated tier.
Classification runs on pushes, description edits, reopening and readiness changes.

Labels are routing hints, **not merge authorization**. A high tier is not a rejection:
every tier passes when classification succeeds. The review-focus line is only checked
for presence, never for meaning. This classifier does not prove that code is safe.

This pilot has **no merge gate**: requiring the `PR risk assessment` check would not be
secure, because any workflow with `checks: write` can create a check with that name. Enforcing
a tier needs a trusted source outside the PR, such as an organization ruleset that requires a
workflow from a protected ref, or a GitHub App. Add one only when a tier starts to
authorize something (for example a fast lane). Until then, existing human and code-owner
review applies to every tier; this PR does not change organization settings, CODEOWNERS,
AI approval policy, or skip any checks. Do not grant AI approval rights for the pilot.

## Risk model above the deterministic floor

The model is an Azure AI deployment that answers one rated-choice question; it is not a
chat-completions model or a third-party reviewer app. Its endpoint, deployment name and
model identity are repository variables, not code.

For deterministic tiers 0–2, one request includes the trusted base-branch rules, the
tier criteria, the deterministic result, and the complete unified diff from GitHub. The
title is not sent: it is author-written text that the tier does not depend on. One
`risk_tier` question returns a rating from 0 to 3. The diff is untrusted evidence: it
cannot change the question, endpoint, credentials or policy, and it is never executed.
Because the model can only raise a tier, a manipulated answer can only add review.
Deterministic tier 3 skips the model entirely.

The check reports the deterministic tier, the model's suggestion with its identity,
uncalibrated confidence and token usage, and the final tier.

The repository variable `RISK_MODEL_MODE` decides what the model may do:

- **`shadow`** (default, any value other than `raise`): the label always uses the
  deterministic tier, and the model's suggestion is only reported. Use this until the
  model's suggestions have been measured against maintainer judgment.
- **`raise`**: final tier = max(deterministic tier, model tier). A fast-lane tier (0 or 1)
  then needs a model assessment, so a change the model did not assess is at least tier 2.

Who gets the model: authors with write access to the repository (`admin`, `maintain` or
`write`), read from the repository permission API. `author_association` is not used for
this, because private organization members can show as `CONTRIBUTOR` and `MEMBER` means
any member of the organization; it is only the fallback when the permission lookup fails,
and the check then says so. Bots such as Dependabot count as authors without write
access. For anyone else, a maintainer adds the `ai-review` label and reruns the
assessment (or the next push or description edit does). The label lasts until a
maintainer removes it, so later pushes also get the model, at one bounded request each.

Every PR gets a label, whatever happens to the model:

| Model state                                                         | `shadow`           | `raise`                   |
| ------------------------------------------------------------------- | ------------------ | ------------------------- |
| Tier 3 (model not called)                                           | 3                  | 3                         |
| Answered                                                            | Deterministic tier | max(deterministic, model) |
| Not configured, or no write access and no `ai-review`               | Deterministic tier | At least 2                |
| Failed, partly or wrongly configured, or the request exceeds 48 KiB | Deterministic tier | At least 2                |

In `raise` mode a model outage, or a large test or story PR over the request limit,
therefore moves fast-lane PRs to tier 2. Decide that before enabling `raise`. The
request has a 48 KiB UTF-8 serialized-body limit and a 30-second deadline; diffs are
never truncated or chunked, and there are no hidden retries. Responses are bounded to
1 MiB and checked for the expected model identity, exact question and choice labels,
exactly the four tier probabilities, normalized finite values, a maximal-probability
selected choice, valid confidence, and nonnegative integer usage.

Before enabling the model, repository administrators configure:

- Repository variables `RISK_MODEL_ENDPOINT` (the `https` URL), `RISK_MODEL_DEPLOYMENT`
  (the deployment name) and `RISK_MODEL_ID` (the model identity the deployment reports).
  The bearer token is only sent to Azure AI hosts (`*.services.ai.azure.com`,
  `*.cognitiveservices.azure.com`, `*.openai.azure.com`); anything else fails as a
  configuration error. Setting any of these or the client ID counts as configured, so a
  partial configuration is reported, not ignored.
- Repository variable `RISK_MODEL_MODE`: leave unset (`shadow`) until the model is evaluated.
- Repository variable `RISK_MODEL_AZURE_CLIENT_ID` for a dedicated Entra application.
- Existing repository secret `AZURE_TENANT_ID` for the deployment's tenant.
- A federated credential permitting only this repository's trusted workflow, and
  least-privilege inference access to the deployment. Do not reuse a broad publishing
  identity.

The job exchanges a GitHub OIDC assertion for the
`https://cognitiveservices.azure.com/.default` scope; no long-lived model key is stored,
and only the assessment job has `id-token: write`. The default OIDC subject identifies
repository, branch or PR context, not a unique workflow, so restrict the federated
credential with
[subject customization](https://docs.github.com/en/actions/reference/security/oidc) so
that no editable PR job can obtain the classifier's identity. This PR provisions no Azure
resources, federated credentials, role assignments or repository settings. Prompts, raw
provider responses, assertions and bearer tokens are never logged: transport errors are
replaced with content-free errors that keep only the HTTP status or a timeout.

Offline tests mock HTTP, verify the deterministic floor, and exercise invalid responses,
injection-bearing diffs and provider failures. An opt-in live smoke test uses the
developer's Azure CLI login without printing its token:

```sh
FLUENT_RISK_LIVE_TEST=1 RISK_MODEL_ENDPOINT=<url> RISK_MODEL_DEPLOYMENT=<name> RISK_MODEL_ID=<id> \
  yarn nx run scripts-github:test --runInBand --testNamePattern="live model deployment" --skipNxCache
```

This only verifies transport and response compatibility, not classification quality or
OIDC provisioning.

## Ownership and rollout

`@microsoft/fluentui-react-build` owns the classifier, evaluation harness, and monthly
review. Area teams maintain their map entries and specialist instructions. The map,
workflow, classifier, and agent instructions are themselves tier 3 changes.

This first increment implements deterministic-plus-model classification and labels,
label-only. Roll out in stages: merge the workflow and run it with the model unconfigured;
then provision the model identity and run it in `shadow` mode; measure; only then
consider `raise` or a merge gate. The introducing PR cannot load its own helpers from the
pre-merge base; do not solve this by executing PR-head code in the privileged job.

Automated AI summaries/reviews, named fast-lane reviewer assignment, scheduled
`/assign-prs`, Teams digests, and third-party reviewer apps are **not enabled** here.
Until routing is automated, maintainers select a reviewer via the existing process.
Do not assume the cross-repository assignment skill can run unattended in a workflow.

Run the classifier and workflow regression cases with:

```sh
yarn nx run scripts-github:test --runInBand
```

Before expanding the pilot, create a shared tracking issue recording the process
owner, evaluation results, corrective actions, and rollout decisions. Add historical
buggy and clean PRs, risk boundaries, and prompt-injection attempts to a versioned
evaluation set, with a held-out subset. Synthetic boundary tests in this increment
are not evidence of real-world review quality. Rerun evaluation whenever prompts,
skills, lint rules, or the map change.

Review monthly: known-issue detection and missed issues, false positives, wrong tiers
(especially unsafe downgrades), regressions, first-human-review/merge latency, and
cost. Report sample sizes and results by tier. Initial targets are at least 90%
agreement with maintainer tier judgments, at least 50% useful/actionable AI findings,
and fewer than 20% unhelpful findings. These targets do not replace missed-issue audits.
Each confirmed failure needs a deterministic check, instruction/map correction, or
documented AI limitation; add misses to evaluation before deploying the correction.

Investigate serious regressions or unsafe assignments immediately. Return affected
PRs to the existing review process and disable the affected automation if needed.
Only expand after adequate historical and live evidence. Option A (AI approvals)
requires Microsoft enterprise/org policy sign-off, validated code-owner compatibility,
stale-approval dismissal on every push, and measured false approvals. Zero observed
regressions without adequate sample size is not sufficient.

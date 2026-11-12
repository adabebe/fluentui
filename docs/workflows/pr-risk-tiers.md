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

The privileged `pull_request_target` job only executes base-branch code and reads
PR metadata through the GitHub API. It never installs dependencies, evaluates PR
content as code, or checks out the head. Changes to the map/classifier take effect after
merge, not on the PR proposing them. Each attempt resolves and pins the current live
base SHA, so a rerun is not permanently bound to an obsolete event base.
An in-progress head-SHA assessment is created before labeler/checkout setup, and an
`always()` finalizer fails it if setup, classification, or cancellation does not finish.
A separate read-only `pull_request` workflow owns the native **PR risk policy** job:
runner startup failure/cancellation fails that native gate even if the privileged
job never starts and cannot invalidate its old custom assessment.
The gate does not trust custom checks, their names, app slugs, or `external_id` values.
It resolves the canonical housekeeping workflow ID and inspects native Actions runs
for that workflow/path, target repository, `pull_request_target` event, head SHA,
and PR-number run title. Only the newest matching run is considered. It must finish
successfully and contain a successful native classification job in its latest attempt,
named with the PR number and a SHA-256 identity of head SHA, base repository/ref/SHA,
title, and body. That job name comes from the trusted bootstrap's outputs, not the
PR workflow or a caller-supplied custom check. Run attempt and PR metadata are checked
again before acceptance. Missing, stale, pending, skipped, failed, or unrelated native
jobs cannot pass it. It polls for at most 150 seconds.
Housekeeping is serialized per PR without cancelling the active run, so an
obsolete-head classifier cannot overwrite a newer head's risk labels. The bootstrap
resolves current metadata after acquiring that serialization and skips obsolete heads.
The read-only gate groups concurrency by PR and head SHA, so obsolete-head reruns
cannot cancel the current-head gate. A same-head edit is resolved from current API metadata.
GitHub concurrency retains only one pending housekeeping run; pending replacement,
runner queues, or fork approval delays can exhaust the gate deadline. Rerun current-head
housekeeping, then the gate after the assessment finishes; no stale success is substituted.
The classifier checks head SHA and base repository/ref/SHA before publishing, and
rejects workflow events that no longer match their trusted checkout.
Reclassification runs on pushes, description
edits, reopening, and readiness changes.

Labels are routing hints, **not merge authorization**. A high tier is not a rejection:
every tier passes when classification succeeds. The review-focus line is only checked
for presence, never for meaning. This classifier does not prove that code is safe.

**Requiring a check named `PR risk policy` is not secure enforcement.** A normal
`pull_request` workflow definition is PR-controlled: an author can preserve that name
and replace its steps with a successful no-op. Checking out base code inside the job,
selecting GitHub Actions as the check source, or adding more in-job guards does not
protect the enclosing YAML.

Organization administrators must enforce **the workflow identity**, not a check name,
using an organization ruleset's **Require workflows to pass before merging** rule.
Select `.github/workflows/pr-risk-gate.yml` from `microsoft/fluentui` at a protected,
trusted source ref (or an approved pinned SHA), never the PR head. Activate the rule
for the target branch without agent bypass actors. This is separate from the
ordinary required-status-check rule. See
[GitHub's required-workflow enforcement](https://github.blog/enterprise-software/ci-cd/enforcing-code-reliability-by-requiring-workflows-with-github-repository-rules/).
Verify availability and actual source/ref behavior with the organization's administrator;
the repository files cannot create this trust boundary. If identity-bound required
workflows are unavailable, do not treat this pilot as a merge gate; a separately
trusted policy GitHub App would be needed instead and is not implemented here.

Also **require branches to be up to date before merging** (strict required checks),
retain human/code-owner approval, and dismiss stale approvals after new commits.
Keep agent identities out of reviewer/bypass roles and protect the workflow source
and policy ownership. The classifier does not inspect reviews or distinguish a
human from an agent using that human's credentials; those are external permission
and review controls. An administrator or authorized bypass actor remains outside
this protection's threat model.
Loose required checks are unsupported: base-branch changes do not emit PR events
and could otherwise leave a previous success valid under old policy.
Additional team-specific
approvals for protected files must be configured using the ruleset's required
reviewers facilities where available; a label cannot enforce them. This PR does
not modify organization settings, CODEOWNERS, AI approval policy, or skip any checks.
Do not grant AI approval rights for the pilot.

## Decision model above the deterministic floor

The model is an Azure deployment (`Decision-1`) that answers one rated-choice
question; it is not a chat-completions model or a third-party reviewer app. Its
endpoint is the repository variable `RISK_DECISION_ENDPOINT`, not code.

For deterministic tiers 0–2, one request includes the trusted base-branch rules, the
tier criteria, the deterministic result, and the complete unified diff from GitHub. The
title is not sent: it is author-written text that the tier does not depend on. One `risk_tier` Choice question returns a rating from 0 to 3. Treat the
diff as untrusted evidence: it cannot change the question, endpoint, credentials,
or policy and is never executed. Prompt-injection instructions explicitly have no
authority, and because the model can only raise a tier, a manipulated answer can only
add review. Deterministic tier 3 skips the model entirely.

The check reports the deterministic tier, the model's suggestion with its identity,
uncalibrated confidence and token usage, and the final tier.

The repository variable `RISK_MODEL_MODE` decides what the model may do:

- **`shadow`** (default, any value other than `raise`): the label always uses the
  deterministic tier, and the model's suggestion is only reported. Use this until the
  model's suggestions have been measured against maintainer judgment.
- **`raise`**: final tier = max(deterministic tier, model tier). A fast-lane tier (0 or 1)
  then needs a model assessment, so a change the model did not assess is at least tier 2.

Who gets the model: pull requests whose author is an owner, member or collaborator
of the repository. For anyone else, a maintainer adds the `ai-review` label and reruns
the assessment (or the next push or description edit does). This bounds model cost and
keeps anonymous fork PRs from spending the deployment. Labels are not part of the
assessed revision, so after adding `ai-review` also rerun the risk gate. The label stays
for the life of the PR: later pushes from the fork also get the model, which costs one
bounded request each; remove the label to stop that.

Every PR gets a label, whatever happens to the model:

| Model state                                                         | `shadow`           | `raise`                   |
| ------------------------------------------------------------------- | ------------------ | ------------------------- |
| Tier 3 (model not called)                                           | 3                  | 3                         |
| Answered                                                            | Deterministic tier | max(deterministic, model) |
| Not configured, or outside contributor without `ai-review`          | Deterministic tier | At least 2                |
| Failed, partly or wrongly configured, or the request exceeds 48 KiB | Deterministic tier | At least 2                |

In `raise` mode a model outage, or a large test or story PR over the request limit,
therefore moves fast-lane PRs to tier 2. Decide that before enabling `raise`. The native request has a 48 KiB UTF-8 serialized-body
limit and a 30-second inference deadline; diffs are never truncated or chunked, and
there are no hidden retries. Responses are bounded to 1 MiB and checked for expected
native model identity, exact question and choice labels, exactly the four tier
probabilities, normalized finite values, a maximal-probability selected choice, valid
confidence, and nonnegative integer usage.

Before enabling the model, repository administrators must configure:

- Repository variable `RISK_DECISION_ENDPOINT`: the `https` URL of the deployment. The
  bearer token is only sent to Azure AI hosts (`*.services.ai.azure.com`,
  `*.cognitiveservices.azure.com`, `*.openai.azure.com`); anything else fails as a
  configuration error. The model counts as configured once this or the client ID is set.
- Repository variable `RISK_MODEL_MODE`: leave unset (`shadow`) until the model is evaluated.
- Repository variable `RISK_CLASSIFIER_AZURE_CLIENT_ID` for a dedicated Entra application.
- Existing repository secret `AZURE_TENANT_ID` for the deployment's tenant.
- A federated credential permitting only the trusted repository workflow's GitHub OIDC
  execution context, and least-privilege inference access to the deployment.
  Do not reuse a broad publishing identity or grant PR-head code access.

The trusted job exchanges a GitHub OIDC assertion for the
`https://cognitiveservices.azure.com/.default` scope. No long-lived model key is stored.
Only the assessment job has `id-token: write`.
The default OIDC subject identifies repository/branch/PR/environment context, not a
unique workflow. The audience alone is not workflow authentication. Configure and
verify supported subject customization including trusted workflow identity, or an
equivalently isolated identity arrangement; do not allow arbitrary editable PR jobs
to obtain the classifier's Azure identity. This configuration is an external rollout
prerequisite, not a property established by the workflow's `id-token: write`.
See [GitHub OIDC claims and subject customization](https://docs.github.com/en/actions/reference/security/oidc).
No Azure resources, federated credentials, role assignments, or repository settings
are provisioned by this PR. Do not log prompts, raw provider responses, assertions,
or bearer tokens.
Transport and body-stream errors (including cancellation cleanup and nested parser
causes) are replaced with content-free errors before Actions can inspect/log them.
Only safe HTTP status and timeout information is retained.

Offline tests mock native HTTP, verify the decision floor, and exercise invalid
responses, injection-bearing diffs, and provider failures. An opt-in synthetic native
smoke test uses the developer's Azure CLI login without printing its token:

```sh
FLUENT_RISK_LIVE_TEST=1 RISK_DECISION_ENDPOINT=<endpoint> yarn nx run scripts-github:test --runInBand --testNamePattern="live Decision deployment" --skipNxCache
```

This only verifies transport/response compatibility, not classification quality or
GitHub OIDC provisioning. Require historical/live classification evaluation before
using model results to change any merge safeguards.

## Ownership and rollout

`@microsoft/fluentui-react-build` owns the classifier, evaluation harness, and monthly
review. Area teams maintain their map entries and specialist instructions. The map,
workflow, classifier, and agent instructions are themselves tier 3 changes.

This first increment implements deterministic-plus-model classification, labels, and description enforcement.
It is not production-qualified by offline tests alone. Bootstrap in stages: provision
the identity/access first, merge the trusted helpers and workflows, then have the
organization administrator select the trusted workflow source/ref in an evaluating
workflow-identity ruleset. Exercise subsequent PRs whose base contains those helpers.
The introducing PR cannot load new helpers from its pre-merge trusted base; do not
solve this by executing PR-head code in the privileged job. Only enable the required
gate after live fork, same-SHA metadata edit, cancellation/setup failure, queued-run
recovery, and base-advancement cases pass. Verify strict checks actually block a
previously passing PR after its base advances. In a controlled test repository also
prove that a PR replacing/deleting/skipping the gate YAML cannot satisfy the
identity-bound rule, and that a forged successful same-name custom check cannot
satisfy the genuine verifier. Test a new push after approval to confirm fresh review
is mandatory. Only then activate the workflow rule. Record the selected workflow
repository/path/ref, rule enforcement, bypass actors, and test results with the rollout
decision; a synthetic local model request does not verify this deployment.

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

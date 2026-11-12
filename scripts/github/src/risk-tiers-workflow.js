// @ts-check

const { decideRisk, getDecisionConfig, getDecisionToken } = require('./risk-decision');
const { revisionKey } = require('./risk-policy');
const { classifyRisk, hasReviewFocus, tierLabels } = require('./risk-tiers');

// Pull requests from these authors get the model automatically; anyone else needs a maintainer's label first.
const trustedAuthors = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const aiReviewLabel = 'ai-review';

/** @typedef {import('./risk-tiers').Tier} Tier */
/** @typedef {(input: Parameters<typeof decideRisk>[0]) => ReturnType<typeof decideRisk>} AssessRisk */

/**
 * @param {{ getIDToken: (audience: string) => Promise<string> }} core
 * @param {NodeJS.ProcessEnv} env
 * @returns {AssessRisk | undefined} The model call, or undefined when no model is configured.
 */
function configuredModel(core, env) {
  let config;
  try {
    config = getDecisionConfig(env);
  } catch (error) {
    // A broken configuration must be visible, so it fails every call instead of disabling the model.
    return () => Promise.reject(error);
  }
  return (
    config &&
    (input => decideRisk(input, { endpoint: config.endpoint, getToken: () => getDecisionToken(core, config) }))
  );
}

/**
 * Asks the model whether the deterministic tier should be higher. The model never lowers a tier and never prevents a
 * label. In shadow mode (the default) its suggestion is only reported and the deterministic tier stands. In raise
 * mode its suggestion applies, and a fast-lane tier (0 or 1) needs a model assessment: when the model is not
 * configured, not allowed to run (an outside contributor's PR without `ai-review`), or fails, the tier is at least 2.
 *
 * @param {{
 *   pull: { title: string; author_association: string; labels: { name?: string }[] };
 *   deterministic: { tier: Tier; reason: string };
 *   getDiff: () => Promise<unknown>;
 *   assessRisk: AssessRisk | undefined;
 *   raise: boolean;
 * }} args
 * @returns {Promise<{ tier: number; summary: string }>}
 */
async function escalate({ pull, deterministic, getDiff, assessRisk, raise }) {
  const floor = deterministic.tier;
  /** @param {string} why */
  const unassessed = why =>
    raise
      ? {
          tier: Math.max(floor, 2),
          summary: `${why} A fast-lane tier needs a model assessment, so the tier is at least 2.`,
        }
      : { tier: floor, summary: `${why} The deterministic tier stands.` };
  if (floor === 3) {
    return { tier: floor, summary: 'Model not called: the deterministic tier is already 3.' };
  }
  if (!assessRisk) {
    return unassessed('Model not configured.');
  }
  if (!trustedAuthors.includes(pull.author_association) && !pull.labels.some(label => label.name === aiReviewLabel)) {
    return unassessed(
      `Model not called for an outside contributor: a maintainer can add the \`${aiReviewLabel}\` label and rerun.`,
    );
  }
  try {
    const diff = await getDiff();
    if (typeof diff !== 'string') {
      throw new Error('GitHub did not return the PR diff.');
    }
    const decision = await assessRisk({ diff, deterministic, title: pull.title });
    const suggested = Math.max(floor, decision.tier);
    const details =
      `Model suggested tier ${decision.tier}. Model ${decision.model}, confidence ${decision.confidence} ` +
      `(uncalibrated), tokens ${decision.inputTokens} input / ${decision.outputTokens} output.`;
    return raise
      ? { tier: suggested, summary: details }
      : {
          tier: floor,
          summary: `Shadow mode, not applied: with the model this would be tier ${suggested}. ${details}`,
        };
  } catch (error) {
    return unassessed(
      `Model could not assess the change (${error instanceof Error ? error.message : 'unknown error'}).`,
    );
  }
}

/**
 * Classifies one pull request revision and publishes exactly one risk label and the `PR risk assessment` check.
 * Runs base-branch code only: it reads the PR through the API and never checks out or executes PR code.
 *
 * @param {{
 *   github: ReturnType<typeof import('@actions/github').getOctokit>,
 *   context: typeof import('@actions/github').context,
 *   core: typeof import('@actions/core'),
 *   checkRun: { id: number; identity: string },
 *   env?: NodeJS.ProcessEnv,
 *   assessRisk?: AssessRisk
 * }} args Set `env.RISK_MODEL_MODE` to `raise` to let the model change labels; anything else is shadow mode.
 */
module.exports = async ({
  github,
  context,
  core,
  checkRun,
  env = process.env,
  assessRisk = configuredModel(core, env),
}) => {
  const { owner, repo } = context.repo;
  const issueNumber = context.issue.number;
  const params = { owner, repo, pull_number: issueNumber };
  try {
    const { data: pull } = await github.rest.pulls.get(params);
    const identity = revisionKey(pull);
    if (!Number.isSafeInteger(checkRun.id) || checkRun.id <= 0 || identity !== checkRun.identity) {
      throw new Error('The PR no longer matches the trusted workflow revision. Trigger a fresh classification.');
    }

    const files = await github.paginate(github.rest.pulls.listFiles, { ...params, per_page: 100 });
    const deterministic = classifyRisk(files, { changedFiles: pull.changed_files });
    const model = await escalate({
      pull,
      deterministic,
      getDiff: async () => (await github.rest.pulls.get({ ...params, mediaType: { format: 'diff' } })).data,
      assessRisk,
      raise: env.RISK_MODEL_MODE === 'raise',
    });
    const tier = model.tier;
    const focusPresent = tier < 2 || hasReviewFocus(pull.body);

    const { data: current } = await github.rest.pulls.get(params);
    if (revisionKey(current) !== identity) {
      throw new Error('The pull request changed during classification. Rerun against the latest revision.');
    }

    const label = tierLabels[tier];
    // Add first: a partial API failure must not remove the previous high-risk warning.
    await github.rest.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: [label] });
    for (const existing of current.labels) {
      if (existing.name && tierLabels.includes(existing.name) && existing.name !== label) {
        await github.rest.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: existing.name });
      }
    }

    const summary = [
      `Tier ${tier} - ${label}.`,
      `Deterministic: tier ${deterministic.tier}. ${deterministic.reason}`,
      model.summary,
      'Pilot: human approval remains required for every tier. Labels never authorize a merge or skip CI.',
      tier === 3 ? 'AI may comment but must not approve tier 3 changes.' : '',
      focusPresent ? '' : 'Add a nonempty `Review focus: ...` line to the PR description for tier 2 or 3.',
    ]
      .filter(Boolean)
      .join('\n\n');
    await github.rest.checks.update({
      owner,
      repo,
      check_run_id: checkRun.id,
      status: 'completed',
      conclusion: focusPresent ? 'success' : 'failure',
      output: { title: `Tier ${tier}: ${focusPresent ? 'policy satisfied' : 'review focus required'}`, summary },
    });
    core.setOutput('check-completed', 'true');
    await core.summary.addRaw(summary).write();
    if (!focusPresent) {
      core.setFailed('Tier 2 and 3 pull requests require a Review focus line.');
    }
  } catch (error) {
    await github.rest.checks.update({
      owner,
      repo,
      check_run_id: checkRun.id,
      status: 'completed',
      conclusion: 'failure',
      output: {
        title: 'Risk classification failed',
        summary: 'No tier is certified. Inspect the failed housekeeping workflow and rerun it before merging.',
      },
    });
    // The check now explains the failure; the workflow finalizer must not replace it with a generic message.
    core.setOutput('check-completed', 'true');
    throw error;
  }
};

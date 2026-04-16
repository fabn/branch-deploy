import * as core from '@actions/core'
import dedent from 'dedent-js'
import {checkInput} from './check-input.js'
import {actionStatus} from './action-status.js'
import {LOCK_METADATA} from './lock-metadata.js'
import {COLORS} from './colors.js'
import {parseParams} from './params.js'

// Helper function to that does environment checks specific to branch deploys
// :param environment_targets_sanitized: The list of environment targets
// :param body: The body of the comment
// :param trigger: The trigger used to initiate the deployment
// :param noop_trigger: The trigger used to initiate a noop deployment
// :param stable_branch: The stable branch
// :param environment: The default environment
// :param param_separator: The separator used to seperate the command from the parameters
// :returns: The environment target if found, false otherwise
async function onDeploymentChecks(
  environment_targets_sanitized,
  body,
  trigger,
  noop_trigger,
  stable_branch,
  environment,
  param_separator
) {
  var bodyFmt = body

  // Seperate the issueops command on the 'param_separator'
  var paramCheck = body.split(param_separator)
  paramCheck.shift() // remove everything before the 'param_separator'
  const params = paramCheck.join(param_separator) // join it all back together (in case there is another separator)
  // if there is anything after the 'param_separator'; output it, log it, and remove it from the body for env checks
  var paramsTrim = null
  var parsed_params = null
  if (params !== '') {
    bodyFmt = body.split(`${param_separator}${params}`)[0].trim()
    paramsTrim = params.trim()
    core.info(
      `🧮 detected parameters in command: ${COLORS.highlight}${paramsTrim}`
    )

    parsed_params = parseParams(paramsTrim)
    core.setOutput('params', paramsTrim)
    core.setOutput('parsed_params', parsed_params) // Also set the parsed parameters as an output, GitHub actions will serialize this as JSON -> https://github.com/actions/runner/blob/078eb3b381939ee6665f545234e1dca5ed07da84/src/Misc/layoutbin/hashFiles/index.js#L525
    core.saveState('params', paramsTrim)
    core.saveState('parsed_params', parsed_params)
  } else {
    core.debug('no parameters detected in command')
    core.setOutput('params', '')
    core.setOutput('parsed_params', '')
    core.saveState('params', '')
    core.saveState('parsed_params', '')
  }

  // check if the body contains an exact SHA targeted for deployment (SHA1 or SHA256)
  var sha = null

  // escape all regex special characters in the trigger
  const escapedTrigger = trigger.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&')
  const regex = new RegExp(
    `${escapedTrigger}\\s+((?![a-f0-9]{40}[a-f0-9]{24})[a-f0-9]{40}|[a-f0-9]{64})`,
    'i'
  )
  // escape all regex special characters in the noop_trigger
  const escapedNoopTrigger = noop_trigger.replace(
    /[-[\]/{}()*+?.\\^$|]/g,
    '\\$&'
  )
  const noopRegex = new RegExp(
    `${escapedNoopTrigger}\\s+((?![a-f0-9]{40}[a-f0-9]{24})[a-f0-9]{40}|[a-f0-9]{64})`,
    'i'
  )

  const match = bodyFmt.trim().match(regex)
  const noopMatch = bodyFmt.trim().match(noopRegex)
  if (match) {
    sha = match[1] // The captured SHA value
    // if a sha was used, then we need to remove it from the body for env checks
    bodyFmt = bodyFmt.replace(new RegExp(`\\s*${sha}\\s*`, 'g'), '').trim()
    core.info(
      `📍 detected SHA in command: ${COLORS.highlight}${sha}${COLORS.reset}`
    )
  } else if (noopMatch) {
    sha = noopMatch[1] // The captured SHA value
    // if a sha was used, then we need to remove it from the body for env checks
    bodyFmt = bodyFmt.replace(new RegExp(`\\s*${sha}\\s*`, 'g'), '').trim()
    core.info(
      `📍 detected SHA in noop command: ${COLORS.highlight}${sha}${COLORS.reset}`
    )
  }

  // Loop through all the environment targets to see if an explicit target is being used
  for (const target of environment_targets_sanitized) {
    // If the body on a branch deploy contains the target
    const deployMatch = targetMatch(
      bodyFmt.replace(trigger, '').trim(),
      target
    )
    if (deployMatch) {
      core.debug(`found environment target for branch deploy: ${deployMatch}`)
      return {
        target: deployMatch,
        stable_branch_used: false,
        noop: false,
        params: paramsTrim,
        parsed_params: parsed_params,
        sha: sha
      }
    }
    // If the body on a noop trigger contains the target
    const noopDeployMatch = targetMatch(
      bodyFmt.replace(noop_trigger, '').trim(),
      target
    )
    if (noopDeployMatch) {
      core.debug(
        `found environment target for noop trigger: ${noopDeployMatch}`
      )
      return {
        target: noopDeployMatch,
        stable_branch_used: false,
        noop: true,
        params: paramsTrim,
        parsed_params: parsed_params,
        sha: sha
      }
    }
    // If the body with 'to <target>' contains the target on a branch deploy
    const afterDeploy = bodyFmt.replace(trigger, '').trim()
    if (afterDeploy.startsWith('to ')) {
      const deployToMatch = targetMatch(afterDeploy.slice(3).trim(), target)
      if (deployToMatch) {
        core.debug(
          `found environment target for branch deploy (with 'to'): ${deployToMatch}`
        )
        return {
          target: deployToMatch,
          stable_branch_used: false,
          noop: false,
          params: paramsTrim,
          parsed_params: parsed_params,
          sha: sha
        }
      }
    }
    // If the body with 'to <target>' contains the target on a noop trigger
    const afterNoop = bodyFmt.replace(noop_trigger, '').trim()
    if (afterNoop.startsWith('to ')) {
      const noopToMatch = targetMatch(afterNoop.slice(3).trim(), target)
      if (noopToMatch) {
        core.debug(
          `found environment target for noop trigger (with 'to'): ${noopToMatch}`
        )
        return {
          target: noopToMatch,
          stable_branch_used: false,
          noop: true,
          params: paramsTrim,
          parsed_params: parsed_params,
          sha: sha
        }
      }
    }
    // If the body with 'to <target>' contains the target on a stable branch deploy
    const afterStableDeploy = bodyFmt
      .replace(`${trigger} ${stable_branch}`, '')
      .trim()
    if (afterStableDeploy.startsWith('to ')) {
      const stableDeployToMatch = targetMatch(
        afterStableDeploy.slice(3).trim(),
        target
      )
      if (stableDeployToMatch) {
        core.debug(
          `found environment target for stable branch deploy (with 'to'): ${stableDeployToMatch}`
        )
        return {
          target: stableDeployToMatch,
          stable_branch_used: true,
          noop: false,
          params: paramsTrim,
          parsed_params: parsed_params,
          sha: sha
        }
      }
    }
    // If the body with 'to <target>' contains the target on a stable branch noop trigger
    const afterStableNoop = bodyFmt
      .replace(`${noop_trigger} ${stable_branch}`, '')
      .trim()
    if (afterStableNoop.startsWith('to ')) {
      const stableNoopToMatch = targetMatch(
        afterStableNoop.slice(3).trim(),
        target
      )
      if (stableNoopToMatch) {
        core.debug(
          `found environment target for stable branch noop trigger (with 'to'): ${stableNoopToMatch}`
        )
        return {
          target: stableNoopToMatch,
          stable_branch_used: true,
          noop: true,
          params: paramsTrim,
          parsed_params: parsed_params,
          sha: sha
        }
      }
    }
    // If the body on a stable branch deploy contains the target
    const stableDeployMatch = targetMatch(
      bodyFmt.replace(`${trigger} ${stable_branch}`, '').trim(),
      target
    )
    if (stableDeployMatch) {
      core.debug(
        `found environment target for stable branch deploy: ${stableDeployMatch}`
      )
      return {
        target: stableDeployMatch,
        stable_branch_used: true,
        noop: false,
        params: paramsTrim,
        parsed_params: parsed_params,
        sha: sha
      }
    }
    // If the body on a stable branch noop trigger contains the target
    const stableNoopMatch = targetMatch(
      bodyFmt.replace(`${noop_trigger} ${stable_branch}`, '').trim(),
      target
    )
    if (stableNoopMatch) {
      core.debug(
        `found environment target for stable branch noop trigger: ${stableNoopMatch}`
      )
      return {
        target: stableNoopMatch,
        stable_branch_used: true,
        noop: true,
        params: paramsTrim,
        parsed_params: parsed_params,
        sha: sha
      }
    }
    // If the body matches the trigger phrase exactly, just use the default environment
    if (bodyFmt.trim() === trigger) {
      core.debug('using default environment for branch deployment')
      return {
        target: environment,
        stable_branch_used: false,
        noop: false,
        params: paramsTrim,
        parsed_params: parsed_params,
        sha: sha
      }
    }
    // If the body matches the noop_trigger phrase exactly, just use the default environment
    if (bodyFmt.trim() === noop_trigger) {
      core.debug('using default environment for noop trigger')
      return {
        target: environment,
        stable_branch_used: false,
        noop: true,
        params: paramsTrim,
        parsed_params: parsed_params,
        sha: sha
      }
    }
    // If the body matches the stable branch phrase exactly, just use the default environment
    if (bodyFmt.trim() === `${trigger} ${stable_branch}`) {
      core.debug('using default environment for stable branch deployment')
      return {
        target: environment,
        stable_branch_used: true,
        noop: false,
        params: paramsTrim,
        parsed_params: parsed_params,
        sha: sha
      }
    }
    // If the body matches the stable branch phrase exactly on a noop trigger, just use the default environment
    if (bodyFmt.trim() === `${noop_trigger} ${stable_branch}`) {
      core.debug('using default environment for stable branch noop trigger')
      return {
        target: environment,
        stable_branch_used: true,
        noop: true,
        params: paramsTrim,
        parsed_params: parsed_params,
        sha: sha
      }
    }
  }

  // If we get here, then no valid environment target was found - everything gets set to false / null
  return {
    target: false,
    stable_branch_used: null,
    noop: null,
    params: null,
    parsed_params: null,
    sha: null
  }
}

// Helper function to that does environment checks specific to lock/unlock commands
// :param environment_targets_sanitized: The list of environment targets
// :param body: The body of the comment
// :param lock_trigger: The trigger used to initiate the lock command
// :param unlock_trigger: The trigger used to initiate the unlock command
// :param environment: The default environment from the Actions inputs
// :returns: The environment target if found, false otherwise
async function onLockChecks(
  environment_targets_sanitized,
  body,
  lock_trigger,
  unlock_trigger,
  environment
) {
  // if the body contains the globalFlag, exit right away as environments are not relevant
  const globalFlag = core.getInput('global_lock_flag').trim()
  if (body.includes(globalFlag)) {
    core.debug('global lock flag found in environment target check')
    return 'GLOBAL_REQUEST'
  }

  // remove any lock flags from the body
  LOCK_METADATA.lockInfoFlags.forEach(flag => {
    body = body.replace(flag, '').trim()
  })

  // remove the --reason <text> from the body if it exists
  if (body.includes('--reason')) {
    core.debug(
      `'--reason' found in comment body: ${body} - attempting to remove for environment checks`
    )
    body = body.split('--reason')[0]
    core.debug(`comment body after '--reason' removal: ${body}`)
  }

  // Get the lock info alias from the action inputs
  const lockInfoAlias = core.getInput('lock_info_alias')

  // if the body matches the lock trigger exactly, just use the default environment
  if (body.trim() === lock_trigger.trim()) {
    core.debug('using default environment for lock request')
    return environment
  }

  // if the body matches the unlock trigger exactly, just use the default environment
  if (body.trim() === unlock_trigger.trim()) {
    core.debug('using default environment for unlock request')
    return environment
  }

  // if the body matches the lock info alias exactly, just use the default environment
  if (body.trim() === lockInfoAlias.trim()) {
    core.debug('using default environment for lock info request')
    return environment
  }

  // Loop through all the environment targets to see if an explicit target is being used
  for (const target of environment_targets_sanitized) {
    // If the body on a lock request contains the target
    const lockMatch = targetMatch(
      body.replace(lock_trigger, '').trim(),
      target
    )
    if (lockMatch) {
      core.debug(`found environment target for lock request: ${lockMatch}`)
      return lockMatch
    }
    const unlockMatch = targetMatch(
      body.replace(unlock_trigger, '').trim(),
      target
    )
    if (unlockMatch) {
      core.debug(`found environment target for unlock request: ${unlockMatch}`)
      return unlockMatch
    }
    const lockInfoMatch = targetMatch(
      body.replace(lockInfoAlias, '').trim(),
      target
    )
    if (lockInfoMatch) {
      core.debug(
        `found environment target for lock info request: ${lockInfoMatch}`
      )
      return lockInfoMatch
    }
  }

  // If we get here, then no valid environment target was found
  return false
}

// Helper function to find the environment URL for a given environment target (if it exists)
// :param environment: The environment target
// :param environment_urls: The environment URLs from the action inputs
// :returns: The environment URL if found, an empty string otherwise
async function findEnvironmentUrl(environment, environment_urls) {
  // The structure: "<environment1>|<url1>,<environment2>|<url2>,etc"

  // If the environment URLs are empty, just return an empty string
  if (checkInput(environment_urls) === null) {
    return null
  }

  // Split the environment URLs into an array
  const environment_urls_array = environment_urls.trim().split(',')

  // Loop through the array and find the environment URL for the given environment target
  for (const environment_url of environment_urls_array) {
    const environment_url_array = environment_url.trim().split('|')
    if (environment_url_array[0] === environment) {
      const environment_url = environment_url_array[1]

      // if the environment url exactly matches 'disabled' then return null
      if (environment_url === 'disabled') {
        core.info(
          `💡 environment url for ${COLORS.highlight}${environment}${COLORS.reset} is explicitly disabled`
        )
        core.saveState('environment_url', 'null')
        core.setOutput('environment_url', 'null')
        return null
      }

      // if the environment url does not match the http(s) schema, log a warning and continue
      if (!environment_url.match(/^https?:\/\//)) {
        core.warning(
          `environment url does not match http(s) schema: ${environment_url}`
        )
        continue
      }

      core.saveState('environment_url', environment_url)
      core.setOutput('environment_url', environment_url)
      core.info(
        `🔗 environment url detected: ${COLORS.highlight}${environment_url}`
      )
      return environment_url
    }
  }

  // If we get here, then no environment URL was found
  core.warning(
    `no valid environment URL found for environment: ${environment} - setting environment URL to 'null' - please check your 'environment_urls' input`
  )
  core.saveState('environment_url', 'null')
  core.setOutput('environment_url', 'null')
  return null
}

// A simple function that checks if an explicit environment target is being used
// :param environment: The default environment from the Actions inputs
// :param body: The comment body
// :param trigger: The trigger prefix
// :param alt_trigger: Usually the noop trigger prefix
// :param stable_branch: The stable branch (only used for branch deploys)
// :param context: The context of the Action
// :param octokit: The Octokit instance
// :param reactionId: The ID of the initial comment reaction (Integer)
// :param lockChecks: Whether or not this is a lock/unlock command (Boolean)
// :param environment_urls: The environment URLs from the action inputs
// :param param_separator: The separator used to split the environment targets (String) - defaults to '|'
// :returns: An object containing the environment target and environment URL
export async function environmentTargets(
  environment,
  body,
  trigger,
  alt_trigger,
  stable_branch,
  context,
  octokit,
  reactionId,
  lockChecks = false,
  environment_urls = null,
  param_separator = '|'
) {
  // Get the environment targets from the action inputs
  const environment_targets = core.getInput('environment_targets')

  // Sanitized the input to remove any whitespace and split into an array
  const environment_targets_sanitized = environment_targets
    .split(',')
    .map(target => target.trim())

  // convert the environment targets into an array joined on ,
  const environment_targets_joined = environment_targets_sanitized.join(',')

  // If lockChecks is set to true, this request is for either a lock/unlock command to check the body for an environment target
  if (lockChecks === true) {
    const environmentDetected = await onLockChecks(
      environment_targets_sanitized,
      body,
      trigger,
      alt_trigger,
      environment
    )
    if (environmentDetected !== false) {
      return {environment: environmentDetected, environmentUrl: null}
    }

    // If we get here, then no valid environment target was found
    const message = dedent(`
    No matching environment target found. Please check your command and try again. You can read more about environment targets in the README of this Action.

    > The following environment targets are available: \`${environment_targets_joined}\`
    `)
    core.warning(message)
    core.saveState('bypass', 'true')

    // Return the action status as a failure
    await actionStatus(
      context,
      octokit,
      reactionId,
      `### ⚠️ Cannot proceed with lock/unlock request\n\n${message}`
    )

    return {environment: false, environmentUrl: null}
  } else {
    // If lockChecks is set to false, this request is for a branch deploy to check the body for an environment target
    const environmentObj = await onDeploymentChecks(
      environment_targets_sanitized,
      body,
      trigger,
      alt_trigger,
      stable_branch,
      environment,
      param_separator
    )

    const environmentDetected = environmentObj.target

    // If no environment target was found, let the user know via a comment and return false
    if (environmentDetected === false) {
      const message = dedent(`
        No matching environment target found. Please check your command and try again. You can read more about environment targets in the README of this Action.

        > The following environment targets are available: \`${environment_targets_joined}\`
      `)
      core.warning(message)
      core.saveState('bypass', 'true')

      // Return the action status as a failure
      await actionStatus(
        context,
        octokit,
        reactionId,
        `### ⚠️ Cannot proceed with deployment\n\n${message}`
      )
      return {
        environment: false,
        environmentUrl: null,
        environmentObj: environmentObj
      }
    }

    // Attempt to get the environment URL from the environment_urls input using the environment target as the key
    const environmentUrl = await findEnvironmentUrl(
      environmentDetected,
      environment_urls
    )

    // Return the environment target
    return {
      environment: environmentDetected,
      environmentUrl: environmentUrl,
      environmentObj: environmentObj
    }
  }
}

// Helper function to match a value against an environment target pattern
// Supports regex patterns in environment_targets (e.g., "dev-.*" matches "dev-feature-1234")
// :param value: The value extracted from the comment body (what the user typed)
// :param target: The target pattern to match against (from environment_targets input)
// :returns: The matched value (string) if it matches, null otherwise
function targetMatch(value, target) {
  if (!target) return null
  try {
    if (new RegExp(`^${target}$`).test(value)) {
      return value
    }
  } catch {
    // Invalid regex pattern — fall back to exact string match
    if (value === target) return value
  }
  return null
}

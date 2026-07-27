import { OctokitClient } from './service.js';
import { createOctokit } from './octokit.js';
import {
  Arguments,
  AdminTeamCache,
  AdminTeamMembersResult,
  CollaboratorEdge,
  IssueStatsResult,
  Logger,
  PullRequestStatsResult,
  RepositoryStats,
  RepoStatsResult,
  ProcessedPageState,
  RepoProcessingResult,
  OrgContext,
  CommandConfig,
  WebhookPresence,
} from './types.js';
import { createLogger } from './logger.js';
import { createAuthConfig } from './auth.js';
import { StateManager } from './state.js';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'fs';

import { withRetry, RetryConfig, RetryResetSignal } from './retry.js';
import {
  generateRepoStatsFileName,
  convertKbToMb,
  checkIfHasMigrationIssues,
  hasLfsTracking,
  formatElapsedTime,
  resolveOutputPath,
  applyBatchStaggerDelay,
  buildSkipRepoSet,
} from './utils.js';
import {
  initializeCsvFile as initializeCsvFileGeneric,
  appendCsvRow,
  readCsvFile,
  REPO_STATS_COLUMNS,
} from './csv.js';
import { initCommand, executeCommand } from './init.js';

// --- Command configuration ---

const repoStatsConfig: CommandConfig = {
  logPrefix: 'repo-stats',
  summaryLabel: 'PROCESSING',
  generateFileName: generateRepoStatsFileName,
  initializeCsvFile: initializeCsvFile,
  processOrg: processOrgRepoStats,
};

// --- Public entry point ---

export async function run(opts: Arguments): Promise<string[]> {
  // Build batch-aware config if batch mode is enabled
  const config = { ...repoStatsConfig };
  if (opts.batchSize != null) {
    const batchIndex = opts.batchIndex ?? 0;
    config.statePrefix = `batch-${batchIndex}`;
    config.generateFileName = (orgName: string) =>
      generateRepoStatsFileName(orgName, batchIndex);

    // Stagger batch start to avoid simultaneous API bursts
    await applyBatchStaggerDelay(batchIndex, opts.batchDelay ?? 0);
  }

  const context = await initCommand(opts, config);
  const result = await executeCommand(context, config);
  return result.outputFiles;
}

// --- Per-org processing (called by shared executeForOrg via config.processOrg) ---

async function processOrgRepoStats(context: OrgContext): Promise<void> {
  const {
    opts,
    logger,
    client,
    fileName,
    processedState,
    retryConfig,
    stateManager,
  } = context;

  const startTime = new Date();
  logger.info(`Started processing at: ${startTime.toISOString()}`);

  // Create a state object to track counts that can be modified by reference
  const resetSignal: RetryResetSignal = { requested: false };
  const processingState = {
    successCount: 0,
    retryCount: 0,
    resetSignal,
  };

  await withRetry(
    async () => {
      const result = await processRepositories({
        client,
        logger,
        opts,
        processedState,
        state: processingState,
        fileName,
        stateManager,
      });

      const endTime = new Date();
      const elapsedTime = formatElapsedTime(startTime, endTime);

      if (result.isComplete) {
        processedState.completedSuccessfully = true;
        logger.info(
          'All repositories have been processed successfully. Marking state as complete.',
        );
      }

      logger.info(
        `Completed processing ${result.processedCount} repositories. ` +
          `Last cursor: ${result.cursor}, ` +
          `Last repo: ${processedState.lastProcessedRepo}\n` +
          `Start time: ${startTime.toISOString()}\n` +
          `End time: ${endTime.toISOString()}\n` +
          `Total elapsed time: ${elapsedTime}\n` +
          `Consecutive successful operations: ${processingState.successCount}\n` +
          `Total retry attempts: ${processingState.retryCount}\n` +
          `Processing completed successfully: ${processedState.completedSuccessfully}\n` +
          `Output saved to: ${fileName}`,
      );

      stateManager.update(processedState, {});

      // Check for and process missing repositories if enabled
      if (opts.autoProcessMissing && result.isComplete) {
        await processMissingRepositories({
          opts,
          fileName,
          client,
          logger,
          processedState,
          retryConfig,
          stateManager,
        });
      }

      // Clean up state file if requested and processing completed successfully
      if (opts.cleanState && result.isComplete) {
        stateManager.cleanup();
      }

      return result;
    },
    retryConfig,
    (state) => {
      processingState.retryCount++;
      processingState.successCount = 0;
      logger.warn(
        `Retry attempt ${state.attempt}: Failed while processing repositories. ` +
          `Current cursor: ${processedState.currentCursor}, ` +
          `Last successful cursor: ${processedState.lastSuccessfulCursor}, ` +
          `Last processed repo: ${processedState.lastProcessedRepo}, ` +
          `Processed repos count: ${processedState.processedRepos.length}, ` +
          `Total retries: ${state.retryCount}, ` +
          `Consecutive successes: ${state.successCount}, ` +
          `Error: ${state.error?.message}\n` +
          `Elapsed time so far: ${formatElapsedTime(startTime, new Date())}`,
      );
      stateManager.update(processedState, {});
    },
    resetSignal,
  );
}

async function processMissingRepositories({
  opts,
  fileName,
  client,
  logger,
  processedState,
  retryConfig,
  stateManager,
}: {
  opts: Arguments;
  fileName: string;
  client: OctokitClient;
  logger: Logger;
  processedState: ProcessedPageState;
  retryConfig: RetryConfig;
  stateManager: StateManager;
}): Promise<void> {
  logger.info('Checking for missing repositories...');
  const missingReposResult = await checkForMissingRepos({
    opts,
    processedFile: fileName,
  });

  const missingReposCount = missingReposResult.missingRepos.length;
  if (missingReposCount === 0) {
    logger.info(
      'No missing repositories found. All repositories have been processed.',
    );
    return;
  }

  logger.info(
    `Found ${missingReposCount} missing repositories that need to be processed`,
  );

  // Reset completedSuccessfully flag since we're now processing additional repos
  processedState.completedSuccessfully = false;
  stateManager.update(processedState, {});
  logger.debug(
    'Reset completedSuccessfully flag for missing repositories processing',
  );

  // Create temporary file with missing repos
  const missingReposFile = `${opts.orgName!}-missing-repos-${new Date().getTime()}.txt`;
  writeFileSync(
    missingReposFile,
    missingReposResult.missingRepos
      .map((repo) => `${opts.orgName!}/${repo}`)
      .join('\n'),
  );
  logger.info(`Created temporary file with missing repos: ${missingReposFile}`);

  try {
    // Process the missing repos
    logger.info('Processing missing repositories...');
    const missingReposResetSignal: RetryResetSignal = { requested: false };
    const missingReposProcessingState = {
      successCount: 0,
      retryCount: 0,
      resetSignal: missingReposResetSignal,
    };

    await withRetry(
      async () => {
        const missingResult = await processRepositoriesFromFile({
          client,
          logger,
          opts: { ...opts, repoList: missingReposFile },
          processedState,
          state: missingReposProcessingState,
          fileName,
          stateManager,
          adminTeamCache: createAdminTeamCache(),
        });

        logger.info(
          `Completed processing ${missingResult.processedCount} out of ${missingReposCount} missing repositories`,
        );

        // Mark as complete if all missing repos were processed
        if (missingResult.isComplete) {
          processedState.completedSuccessfully = true;
          stateManager.update(processedState, {});
          logger.info(
            'All missing repositories processed successfully. Marking state as complete.',
          );
        }

        return missingResult;
      },
      retryConfig,
      (state) => {
        missingReposProcessingState.retryCount++;
        missingReposProcessingState.successCount = 0;
        logger.warn(
          `Retry attempt ${state.attempt}: Failed while processing missing repositories. ` +
            `Error: ${state.error?.message}`,
        );
      },
      missingReposResetSignal,
    );

    logger.info('Completed processing of missing repositories');
  } finally {
    // Clean up temporary file
    if (existsSync(missingReposFile)) {
      unlinkSync(missingReposFile);
      logger.info(`Removed temporary file: ${missingReposFile}`);
    }
  }
}

export function initializeCsvFile(fileName: string, logger: Logger): void {
  initializeCsvFileGeneric(fileName, REPO_STATS_COLUMNS, logger);
}

/**
 * Determines whether a repository has already been processed.
 *
 * Processed repo names are stored lowercased (mapToRepoStatsResult sets
 * Repo_Name to repo.name.toLowerCase(), and that value is what gets recorded
 * in processedState.processedRepos). Callers, however, may hold the original
 * casing (e.g. the repo-list/batch path reads names straight from the input
 * list). Normalising here keeps the membership check case-insensitive so that
 * mixed-case repositories are correctly skipped on resume/retry instead of
 * being re-processed and re-appended, which previously produced many duplicate
 * rows.
 */
export function isRepoAlreadyProcessed(
  processedRepos: string[],
  repoName: string,
): boolean {
  return processedRepos.includes(repoName.toLowerCase());
}

/**
 * Fetches the full list of repository names for an organization using a
 * lightweight GraphQL query, then returns the slice for the requested batch.
 *
 * Logs the total repository count and batch count so users know how many
 * batches to run.
 */
export async function getRepoListForBatch({
  client,
  orgName,
  batchSize,
  batchIndex,
  pageSize,
  logger,
}: {
  client: Pick<OctokitClient, 'listOrgRepoNames'>;
  orgName: string;
  batchSize: number;
  batchIndex: number;
  pageSize: number;
  logger: Logger;
}): Promise<string[]> {
  logger.info(
    `Batch mode: fetching repository list for org '${orgName}' (batch size: ${batchSize}, batch index: ${batchIndex})`,
  );

  const allRepos: string[] = [];
  for await (const repo of client.listOrgRepoNames(orgName, pageSize)) {
    allRepos.push(`${repo.owner.login}/${repo.name}`);
  }

  const totalRepos = allRepos.length;
  const totalBatches = Math.ceil(totalRepos / batchSize);

  logger.info(
    `Total repositories: ${totalRepos}, Total batches: ${totalBatches} (batch size: ${batchSize})`,
  );

  if (totalRepos === 0) {
    logger.info(
      `Organization '${orgName}' has no repositories. Nothing to process.`,
    );
    return [];
  }

  if (batchIndex >= totalBatches) {
    logger.warn(
      `Batch index ${batchIndex} is out of range (total batches: ${totalBatches}). No repositories to process.`,
    );
    return [];
  }

  const start = batchIndex * batchSize;
  const end = Math.min(start + batchSize, totalRepos);
  const batchRepos = allRepos.slice(start, end);

  logger.info(
    `Batch ${batchIndex} of ${totalBatches}: processing repositories ${start + 1}-${end} of ${totalRepos}`,
  );

  return batchRepos;
}

async function analyzeRepositoryStats({
  repo,
  owner,
  extraPageSize,
  client,
  logger,
  adminTeamCache,
}: {
  repo: RepositoryStats;
  owner: string;
  extraPageSize: number;
  client: OctokitClient;
  logger: Logger;
  adminTeamCache: AdminTeamCache;
}): Promise<RepoStatsResult> {
  logger.info(`Analyzing repository: ${owner}/${repo.name}`);

  // Run issue, PR, collaborator analysis, and top contributor fetch concurrently
  const [issueStats, prStats, collaboratorTeams, topContributor, hasWebhooks] =
    await Promise.all([
      analyzeIssues({
        owner,
        repo: repo.name,
        per_page: extraPageSize,
        totalCount: repo.issues.totalCount,
        client,
        logger,
      }),
      analyzePullRequests({
        owner,
        repo: repo.name,
        per_page: extraPageSize,
        totalCount: repo.pullRequests.totalCount,
        client,
        logger,
      }),
      analyzeCollaborators({
        owner,
        repo: repo.name,
        per_page: extraPageSize,
        totalCount: repo.collaborators.totalCount,
        client,
        logger,
      }),
      client.getTopContributor(owner, repo.name),
      client.getRepoHasWebhooks(owner, repo.name),
    ]);

  const { adminTeams, nonAdminTeams } = collaboratorTeams;

  // Resolve team members and SAML identities from the org-level cache
  const teamMembersResult = await resolveAdminTeamMembers({
    org: owner,
    adminTeams,
    per_page: extraPageSize,
    client,
    logger,
    cache: adminTeamCache,
  });

  // Ensure SAML identities are loaded for top contributor lookup
  await ensureSamlLoaded({
    org: owner,
    per_page: extraPageSize,
    client,
    logger,
    cache: adminTeamCache,
  });

  // Look up SAML identity for top contributor
  const topContributorSaml = topContributor
    ? (adminTeamCache.samlIdentities.get(topContributor) ?? '')
    : '';

  return mapToRepoStatsResult(
    repo,
    issueStats,
    prStats,
    adminTeams,
    teamMembersResult,
    topContributor,
    topContributorSaml,
    nonAdminTeams,
    hasWebhooks,
  );
}

async function* processRepoStats({
  reposIterator,
  client,
  logger,
  extraPageSize,
  processedState,
  stateManager,
  adminTeamCache,
  skipRepoSet,
}: {
  reposIterator: AsyncGenerator<RepositoryStats, void, unknown>;
  client: OctokitClient;
  logger: Logger;
  extraPageSize: number;
  processedState: ProcessedPageState;
  stateManager: StateManager;
  adminTeamCache: AdminTeamCache;
  skipRepoSet?: Set<string>;
}): AsyncGenerator<RepoStatsResult> {
  for await (const repo of reposIterator) {
    if (repo.pageInfo?.endCursor) {
      stateManager.update(processedState, {
        newCursor: repo.pageInfo.endCursor,
      });
    }

    if (skipRepoSet?.has(repo.name.toLowerCase())) {
      logger.info(
        `Skipping repository per skip list: ${repo.owner.login}/${repo.name}`,
      );
      continue;
    }

    const result = await analyzeRepositoryStats({
      repo,
      owner: repo.owner.login,
      extraPageSize,
      client,
      logger,
      adminTeamCache,
    });

    yield result;
  }
}

async function handleRepoProcessingSuccess({
  result,
  processedState,
  state,
  opts,
  client,
  logger,
  processedCount,
  stateManager,
}: {
  result: RepoStatsResult;
  processedState: ProcessedPageState;
  state: {
    successCount: number;
    retryCount: number;
    resetSignal?: RetryResetSignal;
  };
  opts: Arguments;
  client: OctokitClient;
  logger: Logger;
  processedCount: number;
  stateManager: StateManager;
}): Promise<void> {
  const successThreshold = opts.retrySuccessThreshold || 5;

  // Track successful processing
  state.successCount++;
  if (state.successCount >= successThreshold && state.retryCount > 0) {
    logger.info(
      `Reset retry count after ${state.successCount} successful operations`,
    );
    state.retryCount = 0;
    state.successCount = 0;
    if (state.resetSignal) {
      state.resetSignal.requested = true;
    }
  }

  stateManager.update(processedState, {
    repoName: result.Repo_Name,
    lastSuccessfulCursor: processedState.currentCursor,
  });

  // Check rate limits after configured interval
  if (processedCount % (opts.rateLimitCheckInterval || 10) === 0) {
    const rateLimitReached = await checkAndHandleRateLimits({
      client,
      logger,
      processedCount,
    });

    if (rateLimitReached) {
      throw new Error(
        'Rate limit reached. Processing will be paused until limits reset.',
      );
    }
  }
}

async function processRepositoriesFromFile({
  client,
  logger,
  opts,
  processedState,
  state,
  fileName,
  stateManager,
  adminTeamCache,
}: {
  client: OctokitClient;
  logger: Logger;
  opts: Arguments;
  processedState: ProcessedPageState;
  state: {
    successCount: number;
    retryCount: number;
    resetSignal?: RetryResetSignal;
  };
  fileName: string;
  stateManager: StateManager;
  adminTeamCache: AdminTeamCache;
}): Promise<RepoProcessingResult> {
  logger.info(`Processing repositories from list: ${opts.repoList}`);

  if (!opts.repoList || opts.repoList.length === 0) {
    throw new Error('Repository list is required and cannot be empty');
  }

  const repoListRaw = Array.isArray(opts.repoList)
    ? opts.repoList
    : readFileSync(opts.repoList, 'utf-8').split('\n');

  const repoList = repoListRaw
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
    .map((line) => {
      const [owner, repo] = line.trim().split('/');
      return { owner, repo };
    })
    .filter(({ owner }) => owner.toLowerCase() === opts.orgName!.toLowerCase());

  logger.info(
    `Filtered to ${repoList.length} repositories for organization: ${opts.orgName}`,
  );

  if (repoList.length === 0) {
    logger.info(
      `No repositories in the list belong to organization: ${opts.orgName}`,
    );
    return {
      cursor: null,
      processedRepos: processedState.processedRepos,
      processedCount: 0,
      isComplete: true,
      successCount: state.successCount,
      retryCount: state.retryCount,
    };
  }

  let processedCount = 0;

  const skipRepoSet = buildSkipRepoSet(opts.skipRepoList, opts.orgName, logger);

  for (const { owner, repo } of repoList) {
    try {
      // Processed repos are stored lowercased (see mapToRepoStatsResult, which
      // The repo-list/batch path carries the original-case name, so the
      // membership check must be case-insensitive (see isRepoAlreadyProcessed).
      // Without this, mixed-case repositories are never recognised as already
      // processed and get re-analysed and re-appended on every retry pass
      // (e.g. after a 500), producing many duplicate rows.
      if (isRepoAlreadyProcessed(processedState.processedRepos, repo)) {
        logger.debug(`Skipping already processed repository: ${repo}`);
        continue;
      }

      if (skipRepoSet.has(repo.toLowerCase())) {
        logger.info(`Skipping repository per skip list: ${owner}/${repo}`);
        continue;
      }

      logger.info(`Processing repository: ${owner}/${repo}`);

      const repoStats = await client.getRepoStats(
        owner,
        repo,
        opts.pageSize != null ? Number(opts.pageSize) : 10,
      );

      const result = await analyzeRepositoryStats({
        repo: repoStats,
        owner,
        extraPageSize:
          opts.extraPageSize != null ? Number(opts.extraPageSize) : 25,
        client,
        logger,
        adminTeamCache,
      });

      await writeResultToCsv(result, fileName, logger);

      await handleRepoProcessingSuccess({
        result,
        processedState,
        state,
        opts,
        client,
        logger,
        processedCount: ++processedCount,
        stateManager,
      });
    } catch (error) {
      state.successCount = 0;
      logger.error(`Failed processing repo ${repo}: ${error}`);
      throw error;
    }
  }

  return {
    cursor: null,
    processedRepos: processedState.processedRepos,
    processedCount,
    isComplete: true,
    successCount: state.successCount,
    retryCount: state.retryCount,
  };
}

async function processRepositories({
  client,
  logger,
  opts,
  processedState,
  state,
  fileName,
  stateManager,
}: {
  client: OctokitClient;
  logger: Logger;
  opts: Arguments;
  processedState: ProcessedPageState;
  state: {
    successCount: number;
    retryCount: number;
    resetSignal?: RetryResetSignal;
  };
  fileName: string;
  stateManager: StateManager;
}): Promise<RepoProcessingResult> {
  logger.debug(
    `Starting/Resuming from cursor: ${processedState.currentCursor}`,
  );

  // Org-level cache for admin team members and SAML identities
  const adminTeamCache = createAdminTeamCache();

  // Batch mode: fetch repo names and process only the batch slice
  if (opts.batchSize != null) {
    const batchRepos = await getRepoListForBatch({
      client,
      orgName: opts.orgName!,
      batchSize: opts.batchSize,
      batchIndex: opts.batchIndex ?? 0,
      pageSize: opts.pageSize || 10,
      logger,
    });

    if (batchRepos.length === 0) {
      logger.info('No repositories in this batch. Nothing to process.');
      return {
        cursor: null,
        processedRepos: processedState.processedRepos,
        processedCount: 0,
        isComplete: true,
        successCount: state.successCount,
        retryCount: state.retryCount,
      };
    }

    return processRepositoriesFromFile({
      client,
      logger,
      opts: { ...opts, repoList: batchRepos },
      processedState,
      state,
      fileName,
      stateManager,
      adminTeamCache,
    });
  }

  if (opts.repoList && opts.repoList.length > 0) {
    return processRepositoriesFromFile({
      client,
      logger,
      opts,
      processedState,
      state,
      fileName,
      stateManager,
      adminTeamCache,
    });
  }

  // Use lastSuccessfulCursor only if cursor is null (first try)
  const startCursor =
    processedState.currentCursor || processedState.lastSuccessfulCursor;
  logger.info(`Using start cursor: ${startCursor}`);

  const reposIterator = client.getOrgRepoStats(
    opts.orgName!,
    opts.pageSize || 10,
    startCursor,
  );

  const skipRepoSet = buildSkipRepoSet(opts.skipRepoList, opts.orgName, logger);

  let processedCount = 0;

  try {
    for await (const result of processRepoStats({
      reposIterator,
      client,
      logger,
      extraPageSize:
        opts.extraPageSize != null ? Number(opts.extraPageSize) : 25,
      processedState,
      stateManager,
      adminTeamCache,
      skipRepoSet,
    })) {
      try {
        if (
          isRepoAlreadyProcessed(
            processedState.processedRepos,
            result.Repo_Name,
          )
        ) {
          logger.debug(
            `Skipping already processed repository: ${result.Repo_Name}`,
          );
          continue;
        }

        await writeResultToCsv(result, fileName, logger);

        await handleRepoProcessingSuccess({
          result,
          processedState,
          state,
          opts,
          client,
          logger,
          processedCount: ++processedCount,
          stateManager,
        });
      } catch (error) {
        state.successCount = 0;
        logger.error(`Failed processing repo ${result.Repo_Name}: ${error}`);
        processedState.currentCursor = processedState.lastSuccessfulCursor;
        throw error;
      }
    }

    // If we get here, we've completed the iteration without errors
    logger.info('Successfully completed processing all repositories');
  } catch (error) {
    // If there's an error during iteration, we'll handle it at the caller
    logger.error(`Error during repository processing: ${error}`);
    throw error;
  }

  logger.info(
    'No more repositories to process - processing completed successfully',
  );

  return {
    cursor: processedState.lastSuccessfulCursor,
    processedRepos: processedState.processedRepos,
    processedCount,
    isComplete: true,
    successCount: state.successCount,
    retryCount: state.retryCount,
  };
}

async function checkAndHandleRateLimits({
  client,
  logger,
  processedCount,
}: {
  client: OctokitClient;
  logger: Logger;
  processedCount: number;
}): Promise<boolean> {
  logger.debug(
    `Checking rate limits after processing ${processedCount} repositories`,
  );
  const rateLimits = await client.checkRateLimits();

  if (
    rateLimits.graphQLRemaining === 0 ||
    rateLimits.apiRemainingRequest === 0
  ) {
    const limitType =
      rateLimits.graphQLRemaining === 0 ? 'GraphQL' : 'REST API';
    logger.warn(
      `${limitType} rate limit reached after processing ${processedCount} repositories`,
    );

    if (rateLimits.messageType === 'error') {
      logger.error(`${rateLimits.message}`);
      throw new Error(
        `${limitType} rate limit exceeded and maximum retries reached`,
      );
    }

    logger.warn(`${rateLimits.message}`);
    logger.info(`GraphQL remaining: ${rateLimits.graphQLRemaining}`);
    logger.info(`REST API remaining: ${rateLimits.apiRemainingRequest}`);

    return true; // indicates rate limit was reached
  } else {
    logger.info(
      `GraphQL remaining: ${rateLimits.graphQLRemaining}, REST API remaining: ${rateLimits.apiRemainingRequest}`,
    );
  }

  return false; // indicates rate limit was not reached
}

export async function writeResultToCsv(
  result: RepoStatsResult,
  fileName: string,
  logger: Logger,
): Promise<void> {
  try {
    const formattedResult = {
      ...result,
      Is_Empty: result.Is_Empty?.toString().toUpperCase() || 'FALSE',
      isFork: result.isFork?.toString().toUpperCase() || 'FALSE',
      isArchived: result.isArchived?.toString().toUpperCase() || 'FALSE',
      isTemplate: result.isTemplate?.toString().toUpperCase() || 'FALSE',
      Has_Wiki: result.Has_Wiki?.toString().toUpperCase() || 'FALSE',
      Has_Webhooks: result.Has_Webhooks || 'UNKNOWN',
      Has_LFS: result.Has_LFS?.toString().toUpperCase() || 'FALSE',
      Auto_Merge_Allowed:
        result.Auto_Merge_Allowed?.toString().toUpperCase() || 'FALSE',
      Delete_Branch_On_Merge:
        result.Delete_Branch_On_Merge?.toString().toUpperCase() || 'FALSE',
      Merge_Commit_Allowed:
        result.Merge_Commit_Allowed?.toString().toUpperCase() || 'FALSE',
      Squash_Merge_Allowed:
        result.Squash_Merge_Allowed?.toString().toUpperCase() || 'FALSE',
      Rebase_Merge_Allowed:
        result.Rebase_Merge_Allowed?.toString().toUpperCase() || 'FALSE',
      Migration_Issue:
        result.Migration_Issue?.toString().toUpperCase() || 'FALSE',
    };

    // Create CSV row manually to maintain strict order
    const values = [
      formattedResult.Org_Name,
      formattedResult.Repo_Name,
      formattedResult.Repo_ID,
      formattedResult.Is_Empty,
      formattedResult.Last_Push,
      formattedResult.Last_Update,
      formattedResult.isFork,
      formattedResult.isArchived,
      formattedResult.isTemplate,
      formattedResult.Visibility,
      formattedResult.Repo_Size_mb,
      formattedResult.Record_Count,
      formattedResult.Collaborator_Count,
      formattedResult.Protected_Branch_Count,
      formattedResult.Ruleset_Count,
      formattedResult.PR_Review_Count,
      formattedResult.Milestone_Count,
      formattedResult.Issue_Count,
      formattedResult.PR_Count,
      formattedResult.PR_Review_Comment_Count,
      formattedResult.Commit_Comment_Count,
      formattedResult.Issue_Comment_Count,
      formattedResult.Issue_Event_Count,
      formattedResult.Release_Count,
      formattedResult.Project_Count,
      formattedResult.Branch_Count,
      formattedResult.Tag_Count,
      formattedResult.Discussion_Count,
      formattedResult.Star_Count,
      formattedResult.Fork_Count,
      formattedResult.Watcher_Count,
      formattedResult.Has_Wiki,
      formattedResult.Has_Webhooks,
      formattedResult.Has_LFS,
      formattedResult.Default_Branch,
      formattedResult.Primary_Language,
      formattedResult.Languages,
      formattedResult.License,
      formattedResult.Topics,
      formattedResult.Description,
      formattedResult.Homepage_URL,
      formattedResult.Auto_Merge_Allowed,
      formattedResult.Delete_Branch_On_Merge,
      formattedResult.Merge_Commit_Allowed,
      formattedResult.Squash_Merge_Allowed,
      formattedResult.Rebase_Merge_Allowed,
      formattedResult.Top_Contributor,
      formattedResult.Top_Contributor_SAML,
      formattedResult.Admin_Teams,
      formattedResult.Admin_Team_Members,
      formattedResult.Admin_Team_Members_SAML,
      formattedResult.Non_Admin_Teams,
      formattedResult.Full_URL,
      formattedResult.Migration_Issue,
      formattedResult.Created,
      formattedResult.Custom_Properties,
      formattedResult.Custom_Property_Owner,
      formattedResult.Custom_Property_CostCode,
      formattedResult.Custom_Property_SystemID,
      formattedResult.Custom_Property_SystemName,
      formattedResult.Custom_Property_SystemType,
      formattedResult.Custom_Property_TechOrg,
      formattedResult.Custom_Property_TechOrgGroup,
      formattedResult.Custom_Property_MigrationReady,
      formattedResult.Custom_Property_MigrationReadyDate,
      formattedResult.Custom_Property_ReviewComplete,
      formattedResult.Custom_Property_TargetOrg,
    ];

    appendCsvRow(fileName, values, logger);

    logger.info(
      `Successfully wrote result for repository: ${result.Repo_Name}`,
    );
  } catch (error) {
    logger.error(
      `Failed to write CSV for repository ${result.Repo_Name}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    throw error;
  }
}

/**
 * Extracts a single custom property's value (case-insensitive lookup on
 * `propertyName`). Multi-select values are joined with semicolons;
 * missing/unset properties resolve to an empty string.
 */
function extractCustomPropertyValue(
  customPropertyValues: RepositoryStats['repositoryCustomPropertyValues'],
  propertyName: string,
): string {
  const property = customPropertyValues?.nodes?.find(
    (p) => p.propertyName.toLowerCase() === propertyName.toLowerCase(),
  );
  return Array.isArray(property?.value)
    ? property.value.join(';')
    : (property?.value ?? '');
}

export function mapToRepoStatsResult(
  repo: RepositoryStats,
  issueStats: IssueStatsResult,
  prStats: PullRequestStatsResult,
  adminTeams: string[] = [],
  teamMembersResult: AdminTeamMembersResult = {
    adminTeamMembers: '',
    adminTeamMembersSaml: '',
  },
  topContributor: string | null = null,
  topContributorSaml: string = '',
  nonAdminTeams: string[] = [],
  hasWebhooks: WebhookPresence = 'UNKNOWN',
): RepoStatsResult {
  const repoSizeMb = convertKbToMb(repo.diskUsage);
  const totalRecordCount = calculateRecordCount(repo, issueStats, prStats);
  const hasMigrationIssues = checkIfHasMigrationIssues({
    repoSizeMb,
    totalRecordCount,
  });

  // Format languages as a semicolon-separated list with percentages
  const languagesStr =
    repo.languages?.edges
      ?.map((edge) => {
        const pct =
          repo.languages.totalSize > 0
            ? ((edge.size / repo.languages.totalSize) * 100).toFixed(1)
            : '0.0';
        return `${edge.node.name}:${pct}%`;
      })
      .join(';') ?? '';

  // Format topics as a semicolon-separated list
  const topicsStr =
    repo.repositoryTopics?.nodes?.map((t) => t.topic.name).join(';') ?? '';

  // Format all set custom properties as a single "name=value" list, sorted by
  // property name for deterministic output. Multi-select values are joined
  // with commas; properties with no value set are omitted entirely.
  const customPropertiesStr = (repo.repositoryCustomPropertyValues?.nodes ?? [])
    .filter((p) => (Array.isArray(p.value) ? p.value.length > 0 : !!p.value))
    .map((p) => ({
      name: p.propertyName,
      value: Array.isArray(p.value) ? p.value.join(',') : p.value,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => `${p.name}=${p.value}`)
    .join(';');

  // Extract dedicated columns for well-known custom properties, in addition
  // to the composite Custom_Properties field above.
  const customPropertyValues = repo.repositoryCustomPropertyValues;
  const customPropertyOwner = extractCustomPropertyValue(
    customPropertyValues,
    'owner',
  );
  const customPropertyCostCode = extractCustomPropertyValue(
    customPropertyValues,
    'costcode',
  );
  const customPropertySystemId = extractCustomPropertyValue(
    customPropertyValues,
    'systemid',
  );
  const customPropertySystemName = extractCustomPropertyValue(
    customPropertyValues,
    'systemname',
  );
  const customPropertySystemType = extractCustomPropertyValue(
    customPropertyValues,
    'systemtype',
  );
  const customPropertyTechOrg = extractCustomPropertyValue(
    customPropertyValues,
    'techorg',
  );
  const customPropertyTechOrgGroup = extractCustomPropertyValue(
    customPropertyValues,
    'techorggroup',
  );
  const customPropertyMigrationReady = extractCustomPropertyValue(
    customPropertyValues,
    'migrationready',
  );
  const customPropertyMigrationReadyDate = extractCustomPropertyValue(
    customPropertyValues,
    'migrationreadydate',
  );
  const customPropertyReviewComplete = extractCustomPropertyValue(
    customPropertyValues,
    'reviewcomplete',
  );
  const customPropertyTargetOrg = extractCustomPropertyValue(
    customPropertyValues,
    'targetorg',
  );

  return {
    Org_Name: repo.owner.login.toLowerCase(),
    Repo_Name: repo.name.toLowerCase(),
    Repo_ID: repo.databaseId,
    Is_Empty: repo.isEmpty,
    Last_Push: repo.pushedAt,
    Last_Update: repo.updatedAt,
    isFork: repo.isFork,
    isArchived: repo.isArchived,
    isTemplate: repo.isTemplate,
    Visibility: repo.visibility ?? '',
    Repo_Size_mb: repoSizeMb,
    Record_Count: totalRecordCount,
    Collaborator_Count: repo.collaborators.totalCount,
    Protected_Branch_Count: repo.branchProtectionRules.totalCount,
    Ruleset_Count: repo.rulesets.totalCount,
    PR_Review_Count: prStats.prReviewCount,
    PR_Review_Comment_Count: prStats.prReviewCommentCount,
    Commit_Comment_Count: repo.commitComments.totalCount,
    Milestone_Count: repo.milestones.totalCount,
    PR_Count: repo.pullRequests.totalCount,
    Project_Count: repo.projectsV2.totalCount,
    Branch_Count: repo.branches.totalCount,
    Release_Count: repo.releases.totalCount,
    Issue_Count: issueStats.totalIssuesCount,
    Issue_Event_Count: issueStats.issueEventCount + prStats.issueEventCount,
    Issue_Comment_Count:
      issueStats.issueCommentCount + prStats.issueCommentCount,
    Tag_Count: repo.tags.totalCount,
    Discussion_Count: repo.discussions.totalCount,
    Star_Count: repo.stargazerCount ?? 0,
    Fork_Count: repo.forkCount ?? 0,
    Watcher_Count: repo.watchers?.totalCount ?? 0,
    Has_Wiki: repo.hasWikiEnabled,
    Has_Webhooks: hasWebhooks,
    Has_LFS: hasLfsTracking(repo.gitattributes?.text),
    Default_Branch: repo.defaultBranchRef?.name ?? '',
    Primary_Language: repo.primaryLanguage?.name ?? '',
    Languages: languagesStr,
    License: repo.licenseInfo?.spdxId || repo.licenseInfo?.name || '',
    Topics: topicsStr,
    Description: repo.description ?? '',
    Homepage_URL: repo.homepageUrl ?? '',
    Auto_Merge_Allowed: repo.autoMergeAllowed ?? false,
    Delete_Branch_On_Merge: repo.deleteBranchOnMerge ?? false,
    Merge_Commit_Allowed: repo.mergeCommitAllowed ?? false,
    Squash_Merge_Allowed: repo.squashMergeAllowed ?? false,
    Rebase_Merge_Allowed: repo.rebaseMergeAllowed ?? false,
    Top_Contributor: topContributor ?? '',
    Top_Contributor_SAML: topContributorSaml,
    Admin_Teams: adminTeams.join(';'),
    Admin_Team_Members: teamMembersResult.adminTeamMembers,
    Admin_Team_Members_SAML: teamMembersResult.adminTeamMembersSaml,
    Non_Admin_Teams: nonAdminTeams.join(';'),
    Full_URL: repo.url,
    Migration_Issue: hasMigrationIssues,
    Created: repo.createdAt,
    Custom_Properties: customPropertiesStr,
    Custom_Property_Owner: customPropertyOwner,
    Custom_Property_CostCode: customPropertyCostCode,
    Custom_Property_SystemID: customPropertySystemId,
    Custom_Property_SystemName: customPropertySystemName,
    Custom_Property_SystemType: customPropertySystemType,
    Custom_Property_TechOrg: customPropertyTechOrg,
    Custom_Property_TechOrgGroup: customPropertyTechOrgGroup,
    Custom_Property_MigrationReady: customPropertyMigrationReady,
    Custom_Property_MigrationReadyDate: customPropertyMigrationReadyDate,
    Custom_Property_ReviewComplete: customPropertyReviewComplete,
    Custom_Property_TargetOrg: customPropertyTargetOrg,
  };
}

function calculateRecordCount(
  repo: RepositoryStats,
  issueStats: IssueStatsResult,
  prStats: PullRequestStatsResult,
): number {
  // Match exactly how the bash script calculates record count (line 918)
  return (
    repo.collaborators.totalCount +
    repo.branchProtectionRules.totalCount +
    prStats.prReviewCount +
    repo.milestones.totalCount +
    issueStats.totalIssuesCount +
    repo.pullRequests.totalCount +
    prStats.prReviewCommentCount +
    repo.commitComments.totalCount +
    issueStats.issueCommentCount +
    prStats.issueCommentCount +
    issueStats.issueEventCount +
    prStats.issueEventCount +
    repo.releases.totalCount +
    repo.projectsV2.totalCount
  );
}

async function analyzeIssues({
  owner,
  repo,
  per_page,
  totalCount,
  client,
  logger,
}: {
  owner: string;
  repo: string;
  per_page: number;
  totalCount: number;
  client: OctokitClient;
  logger: Logger;
}): Promise<IssueStatsResult> {
  logger.debug(`Analyzing issues for repository: ${repo}`);

  if (totalCount <= 0) {
    logger.debug(`No issues found for repository: ${repo}`);
    return {
      totalIssuesCount: totalCount,
      issueEventCount: 0,
      issueCommentCount: 0,
    };
  }

  let totalEventCount = 0;
  let totalCommentCount = 0;

  try {
    for await (const issue of client.getRepoIssues(
      owner,
      repo,
      per_page,
      null,
    )) {
      const eventCount = issue.timeline.totalCount;
      const commentCount = issue.comments.totalCount;

      // Calculate non-comment events by subtracting comments from total timeline events
      totalEventCount += eventCount - commentCount;
      totalCommentCount += commentCount;
    }
  } catch (error) {
    logger.error(
      `Error retrieving issues for ${owner}/${repo}. ` +
        `Consider reducing page size. Error: ${error}`,
      error,
    );
    throw error;
  }

  logger.debug(`Gathered all issues from repository: ${repo}`);
  return {
    totalIssuesCount: totalCount,
    issueEventCount: totalEventCount,
    issueCommentCount: totalCommentCount,
  };
}

async function analyzePullRequests({
  owner,
  repo,
  per_page,
  totalCount,
  client,
  logger,
}: {
  owner: string;
  repo: string;
  per_page: number;
  totalCount: number;
  client: OctokitClient;
  logger: Logger;
}): Promise<PullRequestStatsResult> {
  if (totalCount <= 0) {
    return {
      prReviewCommentCount: 0,
      commitCommentCount: 0,
      issueEventCount: 0,
      issueCommentCount: 0,
      prReviewCount: 0,
    };
  }

  let issueEventCount = 0;
  let issueCommentCount = 0;
  let prReviewCount = 0;
  let prReviewCommentCount = 0;
  let commitCommentCount = 0;

  for await (const pr of client.getRepoPullRequests(
    owner,
    repo,
    per_page,
    null,
  )) {
    const eventCount = pr.timeline.totalCount;
    const commentCount = pr.comments.totalCount;
    const reviewCount = pr.reviews.totalCount;
    const commitCount = pr.commits.totalCount;

    // This matches how the bash script handles event counts
    // It subtracts comments from timeline events, and handles commit limits
    const redundantEventCount =
      commentCount + (commitCount > 250 ? 250 : commitCount);

    const adjustedEventCount = Math.max(0, eventCount - redundantEventCount);

    issueEventCount += adjustedEventCount;
    issueCommentCount += commentCount;
    prReviewCount += reviewCount;

    // Count review comments by examining each review
    for (const review of pr.reviews.nodes) {
      prReviewCommentCount += review.comments.totalCount;
    }

    commitCommentCount += commitCount;
  }

  return {
    prReviewCommentCount,
    commitCommentCount,
    issueEventCount,
    issueCommentCount,
    prReviewCount,
  };
}

export function extractAdminTeams(edges: CollaboratorEdge[]): Set<string> {
  const adminTeams = new Set<string>();
  for (const edge of edges) {
    for (const source of edge.permissionSources) {
      if (source.permission === 'ADMIN' && source.source.slug) {
        adminTeams.add(source.source.slug);
      }
    }
  }
  return adminTeams;
}

export function createAdminTeamCache(): AdminTeamCache {
  return {
    teamMembers: new Map(),
    samlIdentities: new Map(),
    samlLoaded: false,
  };
}

/**
/**
 * Ensures SAML identities are loaded into the org-level cache.
 * Only fetches once per org; subsequent calls are no-ops.
 * If the org has no SAML provider or the token lacks permission,
 * SAML data is silently skipped.
 */
export async function ensureSamlLoaded({
  org,
  per_page,
  client,
  logger,
  cache,
}: {
  org: string;
  per_page: number;
  client: OctokitClient;
  logger: Logger;
  cache: AdminTeamCache;
}): Promise<void> {
  if (cache.samlLoaded) return;

  cache.samlLoaded = true;
  try {
    logger.debug(`Loading SAML identities for org: ${org}`);
    for await (const identity of client.getOrgSamlIdentities(org, per_page)) {
      if (identity.user?.login && identity.samlIdentity?.nameId) {
        cache.samlIdentities.set(
          identity.user.login,
          identity.samlIdentity.nameId,
        );
      }
    }
    logger.debug(
      `Loaded ${cache.samlIdentities.size} SAML identities for org: ${org}`,
    );
  } catch (error) {
    logger.debug(
      `Unable to load SAML identities for org ${org} ` +
        `(org may not have SAML configured or token lacks permission): ${error}`,
    );
  }
}

/**
 * Resolves admin team members and their SAML identities, using the org-level
 * cache to avoid redundant API calls across repos in the same org.
 *
 * For each admin team slug:
 *  - If already cached, reuses the cached member list.
 *  - Otherwise, fetches members via GraphQL and caches the result.
 *
 * SAML identities are loaded once per org (on first call) and cached.
 * If the org has no SAML provider or the token lacks permission, SAML
 * data is silently skipped.
 */
async function resolveAdminTeamMembers({
  org,
  adminTeams,
  per_page,
  client,
  logger,
  cache,
}: {
  org: string;
  adminTeams: string[];
  per_page: number;
  client: OctokitClient;
  logger: Logger;
  cache: AdminTeamCache;
}): Promise<AdminTeamMembersResult> {
  if (adminTeams.length === 0) {
    return { adminTeamMembers: '', adminTeamMembersSaml: '' };
  }

  // Ensure SAML identities are loaded (once per org)
  await ensureSamlLoaded({ org, per_page, client, logger, cache });

  // Resolve members for each admin team
  for (const teamSlug of adminTeams) {
    if (cache.teamMembers.has(teamSlug)) continue;

    try {
      logger.debug(`Fetching members for team: ${org}/${teamSlug}`);
      const members: string[] = [];
      for await (const login of client.getTeamMembers(
        org,
        teamSlug,
        per_page,
      )) {
        members.push(login);
      }
      cache.teamMembers.set(teamSlug, members.sort());
      logger.debug(
        `Found ${members.length} member(s) for team: ${org}/${teamSlug}`,
      );
    } catch (error) {
      logger.error(
        `Error fetching members for team ${org}/${teamSlug}: ${error}`,
      );
      cache.teamMembers.set(teamSlug, []);
    }
  }

  // Build the formatted output strings
  // Admin_Team_Members: team-a:user1|user2;team-b:user3
  // Uses | as the member delimiter to avoid conflicting with CSV commas
  const teamMemberParts: string[] = [];
  const allMemberLogins = new Set<string>();
  for (const teamSlug of adminTeams) {
    const members = cache.teamMembers.get(teamSlug) ?? [];
    for (const login of members) {
      allMemberLogins.add(login);
    }
    if (members.length > 0) {
      teamMemberParts.push(`${teamSlug}:${members.join('|')}`);
    }
  }

  // Admin_Team_Members_SAML: user1:samlId1;user2:samlId2
  const samlParts: string[] = [];
  for (const login of [...allMemberLogins].sort()) {
    const samlId = cache.samlIdentities.get(login);
    if (samlId) {
      samlParts.push(`${login}:${samlId}`);
    }
  }

  return {
    adminTeamMembers: teamMemberParts.join(';'),
    adminTeamMembersSaml: samlParts.join(';'),
  };
}

async function analyzeCollaborators({
  owner,
  repo,
  per_page,
  totalCount,
  client,
  logger,
}: {
  owner: string;
  repo: string;
  per_page: number;
  totalCount: number;
  client: OctokitClient;
  logger: Logger;
}): Promise<{ adminTeams: string[]; nonAdminTeams: string[] }> {
  logger.debug(`Analyzing collaborators for repository: ${repo}`);

  if (totalCount <= 0) {
    logger.debug(`No collaborators found for repository: ${repo}`);
    return { adminTeams: [], nonAdminTeams: [] };
  }

  const adminTeams = new Set<string>();
  const nonAdminTeams = new Set<string>();

  try {
    for await (const edge of client.getRepoCollaborators(
      owner,
      repo,
      per_page,
      null,
    )) {
      for (const source of edge.permissionSources) {
        if (!source.source.slug) continue;
        if (source.permission === 'ADMIN') {
          adminTeams.add(source.source.slug);
        } else {
          nonAdminTeams.add(source.source.slug);
        }
      }
    }
  } catch (error) {
    logger.error(
      `Error retrieving collaborators for ${owner}/${repo}. ` +
        `Error: ${error}`,
      error,
    );
  }

  // A team that has admin access anywhere is treated as an admin team only
  for (const slug of adminTeams) {
    nonAdminTeams.delete(slug);
  }

  const result = {
    adminTeams: [...adminTeams].sort(),
    nonAdminTeams: [...nonAdminTeams].sort(),
  };
  logger.debug(
    `Found ${result.adminTeams.length} admin team(s) and ` +
      `${result.nonAdminTeams.length} non-admin team(s) for repository: ${repo}`,
  );
  return result;
}

export async function checkForMissingRepos({
  opts,
  processedFile,
}: {
  opts: Arguments;
  processedFile: string;
}): Promise<{
  missingRepos: string[];
}> {
  // Initialize only what we need - logger and client
  const logFileName = `${opts.orgName!}-missing-repos-check-${
    new Date().toISOString().split('T')[0]
  }.log`;
  const logger = await createLogger(opts.verbose, logFileName);

  const authConfig = createAuthConfig({ ...opts, logger: logger });
  const octokit = createOctokit(
    authConfig,
    opts.baseUrl,
    opts.proxyUrl,
    logger,
  );
  const client = new OctokitClient(octokit);

  const org = opts.orgName!.toLowerCase();
  const per_page = opts.pageSize || 10;

  logger.debug(`Checking for missing repositories in organization: ${org}`);

  logger.info(
    `Reading processed file: ${processedFile} to check for missing repositories`,
  );
  const records = readCsvFile(processedFile);

  logger.debug(`Parsed ${records.length} records from processed file`);
  const processedReposSet = new Set<string>();
  (records as Array<{ Repo_Name: string }>).forEach((record) => {
    processedReposSet.add(record.Repo_Name.toLowerCase());
  });

  // file name of output file with missing repos with datetime suffix
  function generateTimestampSuffix(date: Date): string {
    const iso = date.toISOString();
    const [datePart, timePart] = iso.split('T');
    const [hour, minute] = timePart.split(':');
    return `${datePart}-${hour}-${minute}`;
  }
  const timestampSuffix = generateTimestampSuffix(new Date());
  const baseMissingReposFileName = `${org}-missing-repos-${timestampSuffix}.csv`;
  const missingReposFileName = await resolveOutputPath(
    opts.outputDir,
    baseMissingReposFileName,
  );

  logger.info('Checking for missing repositories');
  const missingRepos = [];
  const skipRepoSet = buildSkipRepoSet(opts.skipRepoList, opts.orgName, logger);

  if (opts.repoList && opts.repoList.length > 0) {
    // Check missing repos from the provided repo list
    logger.info('Checking against provided repo list');
    const repoListRaw = Array.isArray(opts.repoList)
      ? opts.repoList
      : readFileSync(opts.repoList, 'utf-8').split('\n');

    const repoList = repoListRaw
      .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
      .map((line) => {
        const parts = line.trim().split('/');
        return {
          owner: parts.length > 1 ? parts[0] : '',
          repo: parts.length > 1 ? parts[1] : parts[0],
        };
      })
      .filter(({ owner }) => !owner || owner.toLowerCase() === org);

    logger.info(`Found ${repoList.length} repos for ${org} in repo list`);

    for (const { repo: repoName } of repoList) {
      if (skipRepoSet.has(repoName.toLowerCase())) {
        continue;
      }

      if (!processedReposSet.has(repoName.toLowerCase())) {
        missingRepos.push(repoName);
        const csvRow = `${repoName}\n`;
        appendFileSync(missingReposFileName, csvRow);
      }
    }
  } else {
    // Check missing repos from all org repos
    logger.info('Checking against all organization repositories');
    for await (const repo of client.listReposForOrg(org, per_page)) {
      if (
        processedReposSet.has(repo.name.toLowerCase()) ||
        skipRepoSet.has(repo.name.toLowerCase())
      ) {
        continue;
      } else {
        missingRepos.push(repo.name);
        const csvRow = `${repo.name}\n`;
        appendFileSync(missingReposFileName, csvRow);
      }
    }
  }
  logger.info(`Found ${missingRepos.length} missing repositories`);
  if (missingRepos.length > 0) {
    logger.info(`Missing repositories written to: ${missingReposFileName}`);
  }

  return { missingRepos };
}

import { Octokit } from 'octokit';
import { components } from '@octokit/openapi-types';
import {
  AppInstallation,
  AppInstallationData,
  AuthResponse,
  CollaboratorEdge,
  CollaboratorsResponse,
  IssuesResponse,
  IssueStats,
  OrgRepoNamesResponse,
  OrgSamlIdentitiesResponse,
  ProjectInfo,
  ProjectStatsResult,
  ProjectV2Node,
  PullRequestNode,
  RateLimitCheck,
  RateLimitResponse,
  RateLimitResult,
  RepoProjectCountsResponse,
  RepositoryStats,
  RepoStatsGraphQLResponse,
  SamlExternalIdentityNode,
  TeamMembersResponse,
  WebhookPresence,
} from './types.js';
import {
  ORG_REPO_STATS_QUERY,
  ORG_REPO_NAMES_QUERY,
  SINGLE_REPO_STATS_QUERY,
  REPO_ISSUES_QUERY,
  REPO_PULL_REQUESTS_QUERY,
  REPO_COLLABORATORS_QUERY,
  REPO_PROJECT_COUNTS_QUERY,
  TEAM_MEMBERS_QUERY,
  ORG_SAML_IDENTITIES_QUERY,
} from './queries.js';

type Repository = components['schemas']['repository'];

export const VALID_API_VERSIONS = ['2022-11-28', '2026-03-10'] as const;
export type GitHubApiVersion = (typeof VALID_API_VERSIONS)[number];
export const DEFAULT_API_VERSION: GitHubApiVersion = '2022-11-28';

export class OctokitClient {
  private readonly octokit_headers: { 'X-GitHub-Api-Version': string };

  constructor(
    private readonly octokit: Octokit,
    apiVersion: string = DEFAULT_API_VERSION,
  ) {
    this.octokit_headers = {
      'X-GitHub-Api-Version': apiVersion,
    };
  }

  async generateAppToken(): Promise<string> {
    const appToken = (await this.octokit.auth({
      type: 'installation',
    })) as AuthResponse;
    process.env.GH_TOKEN = appToken.token;
    return appToken.token;
  }

  async *listReposForOrg(
    org: string,
    per_page: number,
  ): AsyncGenerator<components['schemas']['repository'], void, unknown> {
    const iterator = this.octokit.paginate.iterator(
      this.octokit.rest.repos.listForOrg,
      {
        org,
        type: 'all',
        per_page: per_page,
        page: 1,
        headers: this.octokit_headers,
      },
    );

    for await (const { data: repos } of iterator) {
      for (const repo of repos) {
        yield repo as Repository;
      }
    }
  }

  // all repos in an org
  async *getOrgRepoStats(
    org: string,
    per_page: number,
    cursor: string | null = null,
  ): AsyncGenerator<RepositoryStats, void, unknown> {
    const iterator = this.octokit.graphql.paginate.iterator(
      ORG_REPO_STATS_QUERY,
      {
        login: org,
        pageSize: per_page,
        cursor,
      },
    );

    for await (const response of iterator) {
      const repos = response.organization.repositories.nodes;
      const pageInfo = response.organization.repositories.pageInfo;

      for (const repo of repos) {
        yield { ...repo, pageInfo };
      }
    }
  }

  // individual repo stats
  async getRepoStats(
    owner: string,
    repo: string,
    per_page: number,
  ): Promise<RepositoryStats> {
    const response = await this.octokit.graphql<RepoStatsGraphQLResponse>(
      SINGLE_REPO_STATS_QUERY,
      {
        owner,
        name: repo,
      },
    );

    // Create a pageInfo object to maintain consistency with getOrgRepoStats
    const pageInfo = {
      endCursor: null,
      hasNextPage: false,
      startCursor: null,
    };

    return { ...response.repository, pageInfo };
  }

  async *getRepoIssues(
    owner: string,
    repo: string,
    per_page: number,
    cursor: string | null = null,
  ): AsyncGenerator<IssueStats, void, unknown> {
    const iterator = this.octokit.graphql.paginate.iterator<IssuesResponse>(
      REPO_ISSUES_QUERY,
      {
        owner,
        repo,
        pageSize: per_page,
        cursor,
      },
    );

    for await (const response of iterator) {
      const issues = response.repository.issues.nodes;
      for (const issue of issues) {
        yield issue;
      }
    }
  }

  async *getRepoPullRequests(
    owner: string,
    repo: string,
    per_page: number,
    cursor: string | null = null,
  ): AsyncGenerator<PullRequestNode, void, unknown> {
    const iterator = this.octokit.graphql.paginate.iterator(
      REPO_PULL_REQUESTS_QUERY,
      {
        owner,
        repo,
        pageSize: per_page,
        cursor,
      },
    );

    for await (const response of iterator) {
      const prs = response.repository.pullRequests.nodes;
      for (const pr of prs) {
        yield pr;
      }
    }
  }

  async *getRepoCollaborators(
    owner: string,
    repo: string,
    per_page: number,
    cursor: string | null = null,
  ): AsyncGenerator<CollaboratorEdge, void, unknown> {
    const iterator =
      this.octokit.graphql.paginate.iterator<CollaboratorsResponse>(
        REPO_COLLABORATORS_QUERY,
        {
          owner,
          repo,
          pageSize: per_page,
          cursor,
        },
      );

    for await (const response of iterator) {
      const edges = response.repository.collaborators.edges;
      for (const edge of edges) {
        yield edge;
      }
    }
  }

  /**
   * Paginates through all members of a team within an organization.
   * Yields individual member logins.
   */
  async *getTeamMembers(
    org: string,
    teamSlug: string,
    per_page: number,
    cursor: string | null = null,
  ): AsyncGenerator<string, void, unknown> {
    const iterator =
      this.octokit.graphql.paginate.iterator<TeamMembersResponse>(
        TEAM_MEMBERS_QUERY,
        {
          org,
          teamSlug,
          pageSize: per_page,
          cursor,
        },
      );

    for await (const response of iterator) {
      const team = response.organization.team;
      if (!team) break;
      const members = team.members.nodes;
      for (const member of members) {
        yield member.login;
      }
    }
  }

  /**
   * Paginates through all SAML/SSO external identities for an organization.
   * Yields identity nodes containing the GitHub login and SAML nameId.
   * Returns nothing if the organization has no SAML identity provider configured.
   */
  async *getOrgSamlIdentities(
    org: string,
    per_page: number,
    cursor: string | null = null,
  ): AsyncGenerator<SamlExternalIdentityNode, void, unknown> {
    const iterator =
      this.octokit.graphql.paginate.iterator<OrgSamlIdentitiesResponse>(
        ORG_SAML_IDENTITIES_QUERY,
        {
          org,
          pageSize: per_page,
          cursor,
        },
      );

    for await (const response of iterator) {
      const provider = response.organization.samlIdentityProvider;
      if (!provider) break;
      const identities = provider.externalIdentities.nodes;
      for (const identity of identities) {
        yield identity;
      }
    }
  }

  /**
   * Lists repository names for an organization using GraphQL.
   * This is a lightweight alternative to listReposForOrg (REST) that only
   * fetches repo name and owner — avoiding REST API rate limits.
   */
  async *listOrgRepoNames(
    org: string,
    per_page: number,
  ): AsyncGenerator<{ name: string; owner: { login: string } }, void, unknown> {
    const iterator =
      this.octokit.graphql.paginate.iterator<OrgRepoNamesResponse>(
        ORG_REPO_NAMES_QUERY,
        {
          login: org,
          pageSize: per_page,
        },
      );

    for await (const response of iterator) {
      const repos = response.organization.repositories.nodes;
      for (const repo of repos) {
        yield repo;
      }
    }
  }

  /**
   * Paginates through all issues in a repository, collecting their linked
   * ProjectsV2 nodes and computing aggregate project counts.
   *
   * Returns a ProjectStatsResult with:
   * - Issues_Linked_To_Projects: number of issues that have at least one linked ProjectV2
   * - Unique_Projects_Linked_By_Issues: count of distinct ProjectV2 items found across all issues
   * - Projects_Linked_To_Repo: total projectsV2.totalCount on the repository
   */
  async getRepoProjectCounts(
    owner: string,
    repo: string,
    per_page: number,
    onPageProcessed?: (pageNumber: number, issuesInPage: number) => void,
  ): Promise<ProjectStatsResult> {
    const uniqueProjects = new Map<string, ProjectInfo>();
    let issuesLinkedToProjects = 0;
    let projectsLinkedToRepo = 0;

    const iterator =
      this.octokit.graphql.paginate.iterator<RepoProjectCountsResponse>(
        REPO_PROJECT_COUNTS_QUERY,
        {
          owner,
          repo,
          pageSize: per_page,
        },
      );

    let isFirstPage = true;
    let pageNumber = 0;
    for await (const response of iterator) {
      pageNumber++;

      // Capture repo-level project count from the first page
      if (isFirstPage) {
        projectsLinkedToRepo = response.repository.projectsV2?.totalCount ?? 0;
        isFirstPage = false;
      }

      const issues = response.repository.issues.nodes;
      for (const issue of issues) {
        const projects: ProjectV2Node[] = issue.projectsV2?.nodes ?? [];
        if (projects.length > 0) {
          issuesLinkedToProjects++;
        }
        for (const project of projects) {
          const existing = uniqueProjects.get(project.id);
          if (existing) {
            existing.issueCount++;
          } else {
            uniqueProjects.set(project.id, {
              title: project.title,
              issueCount: 1,
            });
          }
        }
      }

      onPageProcessed?.(pageNumber, issues.length);
    }

    return {
      Org_Name: owner,
      Repo_Name: repo,
      Issues_Linked_To_Projects: issuesLinkedToProjects,
      Unique_Projects_Linked_By_Issues: uniqueProjects.size,
      Projects_Linked_To_Repo: projectsLinkedToRepo,
    };
  }

  async checkRateLimits(
    sleepSeconds = 60,
    maxRetries = 5,
  ): Promise<RateLimitResult> {
    const result: RateLimitResult = {
      apiRemainingRequest: 0,
      apiRemainingMessage: '',
      graphQLRemaining: 0,
      graphQLMessage: '',
      message: '',
      messageType: 'info',
    };

    try {
      let sleepCounter = 0;
      const rateLimitCheck = await this.getRateLimitData();

      if (!rateLimitCheck) {
        throw new Error('Failed to get rate limit data');
      }

      result.graphQLRemaining = rateLimitCheck.graphQLRemaining;
      result.apiRemainingRequest = rateLimitCheck.coreRemaining;

      if (rateLimitCheck.message) {
        result.apiRemainingMessage = rateLimitCheck.message;
        result.graphQLMessage = rateLimitCheck.message;
        result.message = rateLimitCheck.message;
        return result;
      }

      if (rateLimitCheck.graphQLRemaining === 0) {
        sleepCounter++;
        const warningMessage = `We have run out of GraphQL calls and need to sleep! Sleeping for ${sleepSeconds} seconds before next check`;

        if (sleepCounter > maxRetries) {
          result.message = `Exceeded maximum retry attempts of ${maxRetries}`;
          result.messageType = 'error';
          return result;
        }

        result.message = warningMessage;
        result.messageType = 'warning';
        result.graphQLMessage = warningMessage;

        await new Promise((resolve) =>
          setTimeout(resolve, sleepSeconds * 1000),
        );
      } else {
        const message = `Rate limits remaining: ${rateLimitCheck.graphQLRemaining.toLocaleString()} GraphQL points ${rateLimitCheck.coreRemaining.toLocaleString()} REST calls`;
        result.message = message;
        result.messageType = 'info';
        result.graphQLMessage = message;
      }
    } catch (error) {
      result.message =
        error instanceof Error
          ? error.message
          : 'Failed to get valid response back from GitHub API!';
      result.messageType = 'error';
    }

    return result;
  }

  private async getRateLimitData(): Promise<RateLimitCheck | null> {
    const response = await this.octokit.request('GET /rate_limit');
    const rateLimitData = response.data as RateLimitResponse;

    if (rateLimitData.message === 'Rate limiting is not enabled.') {
      return {
        graphQLRemaining: 9999999999,
        coreRemaining: 9999999999,
        message: 'API rate limiting is not enabled.',
      };
    }

    return {
      graphQLRemaining: rateLimitData.resources?.graphql.remaining || 0,
      coreRemaining: rateLimitData.resources?.core.remaining || 0,
      message: '',
    };
  }

  // --- App Installation methods (REST API) ---

  /**
   * Fetches all app installations for a GitHub organization and categorizes
   * them into org-wide and repo-specific installations.
   *
   * Requires a Personal Access Token with `admin:org` scope (classic) or
   * `Administration: read` permission (fine-grained). The authenticated user
   * must be an organization owner.
   *
   * Uses REST API: GET /orgs/{org}/installations
   */
  async getOrgInstallations(org: string): Promise<{
    orgWideInstallations: AppInstallation[];
    repoSpecificInstallations: AppInstallation[];
  }> {
    const orgWideInstallations: AppInstallation[] = [];
    const repoSpecificInstallations: AppInstallation[] = [];

    const iterator = this.octokit.paginate.iterator(
      this.octokit.rest.orgs.listAppInstallations,
      {
        org,
        per_page: 100,
        headers: this.octokit_headers,
      },
    );

    for await (const { data: installations } of iterator) {
      for (const installation of installations) {
        const entry: AppInstallation = {
          id: installation.id,
          app_slug: installation.app_slug || String(installation.app_id),
          repository_selection: installation.repository_selection as
            | 'all'
            | 'selected',
        };

        if (installation.repository_selection === 'all') {
          orgWideInstallations.push(entry);
        } else if (installation.repository_selection === 'selected') {
          repoSpecificInstallations.push(entry);
        }
      }
    }

    return { orgWideInstallations, repoSpecificInstallations };
  }

  /**
   * Fetches the list of repository names for a specific app installation.
   *
   * Uses REST API: GET /user/installations/{installation_id}/repositories
   */
  async getInstallationRepositories(installationId: number): Promise<string[]> {
    const repoNames: string[] = [];

    const iterator = this.octokit.paginate.iterator(
      this.octokit.rest.apps.listInstallationReposForAuthenticatedUser,
      {
        installation_id: installationId,
        per_page: 100,
        headers: this.octokit_headers,
      },
    );

    for await (const { data: repositories } of iterator) {
      for (const repo of repositories) {
        repoNames.push(repo.name);
      }
    }

    return repoNames;
  }

  /**
   * Gathers complete app installation data for an organization.
   * Fetches all installations, categorizes them, and for each repo-specific
   * installation, fetches the list of repositories it's installed on.
   *
   * Returns an AppInstallationData object with all categorized data ready
   * for CSV output.
   */
  async getOrgAppInstallationData(
    org: string,
    onInstallationProcessed?: (
      appSlug: string,
      repoCount: number,
    ) => void | Promise<void>,
  ): Promise<AppInstallationData> {
    const { orgWideInstallations, repoSpecificInstallations } =
      await this.getOrgInstallations(org);

    const installationRepos: Record<string, string[]> = {};
    const repoApps: Record<string, string[]> = {};

    for (const installation of repoSpecificInstallations) {
      const repoNames = await this.getInstallationRepositories(installation.id);
      installationRepos[installation.app_slug] = repoNames;

      for (const repoName of repoNames) {
        if (!repoApps[repoName]) {
          repoApps[repoName] = [];
        }
        repoApps[repoName].push(installation.app_slug);
      }

      await onInstallationProcessed?.(installation.app_slug, repoNames.length);
    }

    return {
      orgName: org,
      orgWideInstallations,
      repoSpecificInstallations,
      installationRepos,
      repoApps,
    };
  }

  // --- Top Contributor method (REST API) ---

  /**
   * Fetches the top contributor (by commit count) for a repository.
   *
   * Uses REST API: GET /repos/{owner}/{repo}/contributors with per_page=1
   * to efficiently retrieve only the highest contributor.
   *
   * Returns the login of the top contributor, or null if no contributors
   * are found (e.g. empty repos, or repos with only anonymous commits).
   */
  async getTopContributor(owner: string, repo: string): Promise<string | null> {
    try {
      const response = await this.octokit.rest.repos.listContributors({
        owner,
        repo,
        per_page: 1,
        anon: 'false',
        headers: this.octokit_headers,
      });

      const topContributor = response.data[0];
      return topContributor?.login ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Determines whether a repository has any webhooks configured.
   *
   * Uses REST API: GET /repos/{owner}/{repo}/hooks with per_page=1 to minimize
   * payload and request cost. Returns 'UNKNOWN' when permissions do not allow
   * webhook visibility (e.g. 403/404), so callers do not misclassify repos.
   */
  async getRepoHasWebhooks(
    owner: string,
    repo: string,
  ): Promise<WebhookPresence> {
    try {
      const response = await this.octokit.request(
        'GET /repos/{owner}/{repo}/hooks',
        {
          owner,
          repo,
          per_page: 1,
          headers: this.octokit_headers,
        },
      );

      return response.data.length > 0 ? 'TRUE' : 'FALSE';
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (status === 403 || status === 404) {
        return 'UNKNOWN';
      }
      throw error;
    }
  }
}

import { describe, it, expect } from 'vitest';
import {
  ORG_REPO_STATS_QUERY,
  SINGLE_REPO_STATS_QUERY,
  REPO_ISSUES_QUERY,
  REPO_PULL_REQUESTS_QUERY,
  REPO_COLLABORATORS_QUERY,
  TEAM_MEMBERS_QUERY,
  ORG_SAML_IDENTITIES_QUERY,
} from '../src/queries.js';

describe('GraphQL Queries', () => {
  describe('ORG_REPO_STATS_QUERY', () => {
    it('should be a non-empty string', () => {
      expect(ORG_REPO_STATS_QUERY).toBeDefined();
      expect(typeof ORG_REPO_STATS_QUERY).toBe('string');
      expect(ORG_REPO_STATS_QUERY.length).toBeGreaterThan(0);
    });

    it('should define the orgRepoStats query with correct variables', () => {
      expect(ORG_REPO_STATS_QUERY).toContain('query orgRepoStats');
      expect(ORG_REPO_STATS_QUERY).toContain('$login: String!');
      expect(ORG_REPO_STATS_QUERY).toContain('$pageSize: Int!');
      expect(ORG_REPO_STATS_QUERY).toContain('$cursor: String');
    });

    it('should query organization repositories with pagination', () => {
      expect(ORG_REPO_STATS_QUERY).toContain('organization(login: $login)');
      expect(ORG_REPO_STATS_QUERY).toContain(
        'repositories(first: $pageSize, after: $cursor',
      );
      expect(ORG_REPO_STATS_QUERY).toContain('pageInfo');
      expect(ORG_REPO_STATS_QUERY).toContain('endCursor');
      expect(ORG_REPO_STATS_QUERY).toContain('hasNextPage');
      expect(ORG_REPO_STATS_QUERY).toContain('startCursor');
    });

    it('should contain all new repository fields', () => {
      const newFields = [
        'autoMergeAllowed',
        'defaultBranchRef',
        'deleteBranchOnMerge',
        'description',
        'forkCount',
        'homepageUrl',
        'isTemplate',
        'languages',
        'licenseInfo',
        'mergeCommitAllowed',
        'primaryLanguage',
        'rebaseMergeAllowed',
        'repositoryTopics',
        'squashMergeAllowed',
        'stargazerCount',
        'visibility',
        'watchers',
      ];

      for (const field of newFields) {
        expect(ORG_REPO_STATS_QUERY).toContain(field);
      }
    });

    it('should contain all original repository fields', () => {
      const originalFields = [
        'branches',
        'branchProtectionRules',
        'rulesets',
        'commitComments',
        'collaborators',
        'createdAt',
        'diskUsage',
        'discussions',
        'hasWikiEnabled',
        'isEmpty',
        'isArchived',
        'isFork',
        'issues',
        'milestones',
        'name',
        'owner',
        'projectsV2',
        'pullRequests',
        'pushedAt',
        'releases',
        'tags',
        'updatedAt',
        'url',
      ];

      for (const field of originalFields) {
        expect(ORG_REPO_STATS_QUERY).toContain(field);
      }
    });

    it('should include language details with size and name', () => {
      expect(ORG_REPO_STATS_QUERY).toContain('totalSize');
      expect(ORG_REPO_STATS_QUERY).toContain('edges');
      expect(ORG_REPO_STATS_QUERY).toContain('size');
    });

    it('should include license fields', () => {
      expect(ORG_REPO_STATS_QUERY).toContain('spdxId');
    });

    it('should include repository topics', () => {
      expect(ORG_REPO_STATS_QUERY).toContain('repositoryTopics');
      expect(ORG_REPO_STATS_QUERY).toContain('topic');
    });
  });

  describe('SINGLE_REPO_STATS_QUERY', () => {
    it('should be a non-empty string', () => {
      expect(SINGLE_REPO_STATS_QUERY).toBeDefined();
      expect(typeof SINGLE_REPO_STATS_QUERY).toBe('string');
      expect(SINGLE_REPO_STATS_QUERY.length).toBeGreaterThan(0);
    });

    it('should define the repoStats query with correct variables', () => {
      expect(SINGLE_REPO_STATS_QUERY).toContain('query repoStats');
      expect(SINGLE_REPO_STATS_QUERY).toContain('$owner: String!');
      expect(SINGLE_REPO_STATS_QUERY).toContain('$name: String!');
    });

    it('should query repository by owner and name', () => {
      expect(SINGLE_REPO_STATS_QUERY).toContain(
        'repository(owner: $owner, name: $name)',
      );
    });

    it('should contain all new repository fields', () => {
      const newFields = [
        'autoMergeAllowed',
        'defaultBranchRef',
        'deleteBranchOnMerge',
        'description',
        'forkCount',
        'homepageUrl',
        'isTemplate',
        'languages',
        'licenseInfo',
        'mergeCommitAllowed',
        'primaryLanguage',
        'rebaseMergeAllowed',
        'repositoryTopics',
        'squashMergeAllowed',
        'stargazerCount',
        'visibility',
        'watchers',
      ];

      for (const field of newFields) {
        expect(SINGLE_REPO_STATS_QUERY).toContain(field);
      }
    });

    it('should share the same repository fields as ORG_REPO_STATS_QUERY', () => {
      // Both queries should contain the same core fields
      const sharedFields = [
        'autoMergeAllowed',
        'branches',
        'branchProtectionRules',
        'commitComments',
        'collaborators',
        'createdAt',
        'defaultBranchRef',
        'deleteBranchOnMerge',
        'description',
        'diskUsage',
        'discussions',
        'forkCount',
        'hasWikiEnabled',
        'homepageUrl',
        'isEmpty',
        'isArchived',
        'isFork',
        'isTemplate',
        'issues',
        'languages',
        'licenseInfo',
        'mergeCommitAllowed',
        'milestones',
        'name',
        'owner',
        'primaryLanguage',
        'projectsV2',
        'pullRequests',
        'pushedAt',
        'rebaseMergeAllowed',
        'releases',
        'repositoryTopics',
        'rulesets',
        'squashMergeAllowed',
        'stargazerCount',
        'tags',
        'updatedAt',
        'url',
        'visibility',
        'watchers',
      ];

      for (const field of sharedFields) {
        expect(ORG_REPO_STATS_QUERY).toContain(field);
        expect(SINGLE_REPO_STATS_QUERY).toContain(field);
      }
    });

    it('should include gitattributes object expression for LFS detection', () => {
      expect(ORG_REPO_STATS_QUERY).toContain('gitattributes');
      expect(ORG_REPO_STATS_QUERY).toContain('HEAD:.gitattributes');
      expect(SINGLE_REPO_STATS_QUERY).toContain('gitattributes');
      expect(SINGLE_REPO_STATS_QUERY).toContain('HEAD:.gitattributes');
    });
  });

  describe('REPO_ISSUES_QUERY', () => {
    it('should be a non-empty string', () => {
      expect(REPO_ISSUES_QUERY).toBeDefined();
      expect(typeof REPO_ISSUES_QUERY).toBe('string');
      expect(REPO_ISSUES_QUERY.length).toBeGreaterThan(0);
    });

    it('should define the repoIssues query with correct variables', () => {
      expect(REPO_ISSUES_QUERY).toContain('query repoIssues');
      expect(REPO_ISSUES_QUERY).toContain('$owner: String!');
      expect(REPO_ISSUES_QUERY).toContain('$repo: String!');
      expect(REPO_ISSUES_QUERY).toContain('$pageSize: Int!');
      expect(REPO_ISSUES_QUERY).toContain('$cursor: String');
    });

    it('should query issues with pagination and timeline/comment nodes', () => {
      expect(REPO_ISSUES_QUERY).toContain('issues(first: $pageSize');
      expect(REPO_ISSUES_QUERY).toContain('timeline');
      expect(REPO_ISSUES_QUERY).toContain('comments');
      expect(REPO_ISSUES_QUERY).toContain('totalCount');
    });
  });

  describe('REPO_PULL_REQUESTS_QUERY', () => {
    it('should be a non-empty string', () => {
      expect(REPO_PULL_REQUESTS_QUERY).toBeDefined();
      expect(typeof REPO_PULL_REQUESTS_QUERY).toBe('string');
      expect(REPO_PULL_REQUESTS_QUERY.length).toBeGreaterThan(0);
    });

    it('should define the repoPullRequests query with correct variables', () => {
      expect(REPO_PULL_REQUESTS_QUERY).toContain('query repoPullRequests');
      expect(REPO_PULL_REQUESTS_QUERY).toContain('$owner: String!');
      expect(REPO_PULL_REQUESTS_QUERY).toContain('$repo: String!');
      expect(REPO_PULL_REQUESTS_QUERY).toContain('$pageSize: Int!');
      expect(REPO_PULL_REQUESTS_QUERY).toContain('$cursor: String');
    });

    it('should query pull requests with nested reviews', () => {
      expect(REPO_PULL_REQUESTS_QUERY).toContain(
        'pullRequests(first: $pageSize',
      );
      expect(REPO_PULL_REQUESTS_QUERY).toContain('reviews');
      expect(REPO_PULL_REQUESTS_QUERY).toContain('commits');
      expect(REPO_PULL_REQUESTS_QUERY).toContain('number');
      expect(REPO_PULL_REQUESTS_QUERY).toContain('timeline');
      expect(REPO_PULL_REQUESTS_QUERY).toContain('comments');
    });
  });

  describe('REPO_COLLABORATORS_QUERY', () => {
    it('should be a non-empty string', () => {
      expect(REPO_COLLABORATORS_QUERY).toBeDefined();
      expect(typeof REPO_COLLABORATORS_QUERY).toBe('string');
      expect(REPO_COLLABORATORS_QUERY.length).toBeGreaterThan(0);
    });

    it('should define the repoCollaborators query with correct variables', () => {
      expect(REPO_COLLABORATORS_QUERY).toContain('query repoCollaborators');
      expect(REPO_COLLABORATORS_QUERY).toContain('$owner: String!');
      expect(REPO_COLLABORATORS_QUERY).toContain('$repo: String!');
      expect(REPO_COLLABORATORS_QUERY).toContain('$pageSize: Int!');
      expect(REPO_COLLABORATORS_QUERY).toContain('$cursor: String');
    });

    it('should query collaborators with permissionSources and team slug', () => {
      expect(REPO_COLLABORATORS_QUERY).toContain(
        'collaborators(first: $pageSize',
      );
      expect(REPO_COLLABORATORS_QUERY).toContain('permissionSources');
      expect(REPO_COLLABORATORS_QUERY).toContain('permission');
      expect(REPO_COLLABORATORS_QUERY).toContain('... on Team');
      expect(REPO_COLLABORATORS_QUERY).toContain('slug');
    });
  });

  describe('ORG_REPO_STATS_QUERY collaborators field', () => {
    it('should only include totalCount for collaborators (deep-paginated separately)', () => {
      expect(ORG_REPO_STATS_QUERY).toContain('collaborators');
      expect(ORG_REPO_STATS_QUERY).toContain('totalCount');
    });
  });

  describe('TEAM_MEMBERS_QUERY', () => {
    it('should be a non-empty string', () => {
      expect(TEAM_MEMBERS_QUERY).toBeDefined();
      expect(typeof TEAM_MEMBERS_QUERY).toBe('string');
      expect(TEAM_MEMBERS_QUERY.length).toBeGreaterThan(0);
    });

    it('should define the teamMembers query with correct variables', () => {
      expect(TEAM_MEMBERS_QUERY).toContain('query teamMembers');
      expect(TEAM_MEMBERS_QUERY).toContain('$org: String!');
      expect(TEAM_MEMBERS_QUERY).toContain('$teamSlug: String!');
      expect(TEAM_MEMBERS_QUERY).toContain('$pageSize: Int!');
      expect(TEAM_MEMBERS_QUERY).toContain('$cursor: String');
    });

    it('should query team members with pagination and login', () => {
      expect(TEAM_MEMBERS_QUERY).toContain('organization(login: $org)');
      expect(TEAM_MEMBERS_QUERY).toContain('team(slug: $teamSlug)');
      expect(TEAM_MEMBERS_QUERY).toContain('members(first: $pageSize');
      expect(TEAM_MEMBERS_QUERY).toContain('login');
      expect(TEAM_MEMBERS_QUERY).toContain('pageInfo');
      expect(TEAM_MEMBERS_QUERY).toContain('endCursor');
      expect(TEAM_MEMBERS_QUERY).toContain('hasNextPage');
    });
  });

  describe('ORG_SAML_IDENTITIES_QUERY', () => {
    it('should be a non-empty string', () => {
      expect(ORG_SAML_IDENTITIES_QUERY).toBeDefined();
      expect(typeof ORG_SAML_IDENTITIES_QUERY).toBe('string');
      expect(ORG_SAML_IDENTITIES_QUERY.length).toBeGreaterThan(0);
    });

    it('should define the orgSamlIdentities query with correct variables', () => {
      expect(ORG_SAML_IDENTITIES_QUERY).toContain('query orgSamlIdentities');
      expect(ORG_SAML_IDENTITIES_QUERY).toContain('$org: String!');
      expect(ORG_SAML_IDENTITIES_QUERY).toContain('$pageSize: Int!');
      expect(ORG_SAML_IDENTITIES_QUERY).toContain('$cursor: String');
    });

    it('should query SAML identity provider with external identities', () => {
      expect(ORG_SAML_IDENTITIES_QUERY).toContain(
        'organization(login: $org)',
      );
      expect(ORG_SAML_IDENTITIES_QUERY).toContain('samlIdentityProvider');
      expect(ORG_SAML_IDENTITIES_QUERY).toContain('externalIdentities');
      expect(ORG_SAML_IDENTITIES_QUERY).toContain('login');
      expect(ORG_SAML_IDENTITIES_QUERY).toContain('samlIdentity');
      expect(ORG_SAML_IDENTITIES_QUERY).toContain('nameId');
    });
  });
});

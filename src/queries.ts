/**
 * Shared GraphQL query fragments and constants for GitHub repository statistics.
 *
 * Both getOrgRepoStats and getRepoStats use the same set of repository fields.
 * This file centralizes those field definitions to keep them DRY and makes it
 * easy to add or remove fields in one place.
 */

/**
 * Common repository fields shared by both org-level and single-repo queries.
 * Only fetches totalCount for issues, pull requests, and collaborators.
 * Full node data for these connections is retrieved separately via
 * deep-pagination queries (getRepoIssues / getRepoPullRequests /
 * getRepoCollaborators).
 */
const REPO_STATS_FIELDS = `
  databaseId
  autoMergeAllowed
  branches: refs(refPrefix: "refs/heads/") {
    totalCount
  }
  branchProtectionRules {
    totalCount
  }
  # includeParents is set to true by default for rulesets, so this count also
  # includes active rulesets configured at higher levels that apply to this repository.
  # Explicitly setting it to true for safety in case the default behaviour changes.
  rulesets(includeParents: true) {
    totalCount
  }
  commitComments {
    totalCount
  }
  collaborators {
    totalCount
  }
  createdAt
  defaultBranchRef {
    name
  }
  deleteBranchOnMerge
  description
  diskUsage
  discussions {
    totalCount
  }
  forkCount
  hasWikiEnabled
  homepageUrl
  isEmpty
  isArchived
  isFork
  isTemplate
  issues {
    totalCount
  }
  # Returns the top 10 languages by size; repos with more than 10
  # will only show the largest ones, with percentages recalculated accordingly.
  languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
    totalCount
    totalSize
    edges {
      size
      node {
        name
        color
      }
    }
  }
  licenseInfo {
    name
    spdxId
  }
  mergeCommitAllowed
  milestones {
    totalCount
  }
  name
  owner {
    login
  }
  primaryLanguage {
    name
  }
  projectsV2 {
    totalCount
  }
  pullRequests {
    totalCount
  }
  pushedAt
  rebaseMergeAllowed
  releases {
    totalCount
  }
  repositoryTopics(first: 20) {
    totalCount
    nodes {
      topic {
        name
      }
    }
  }
  repositoryCustomPropertyValues(first: 50) {
    nodes {
      propertyName
      value
    }
  }
  squashMergeAllowed
  stargazerCount
  tags: refs(refPrefix: "refs/tags/") {
    totalCount
  }
  updatedAt
  url
  visibility
  watchers {
    totalCount
  }
  gitattributes: object(expression: "HEAD:.gitattributes") {
    ... on Blob {
      text
    }
  }
`;

/**
 * Query for fetching repository stats across all repos in an organization.
 * Paginates through repositories using cursor-based pagination.
 */
export const ORG_REPO_STATS_QUERY = `
  query orgRepoStats($login: String!, $pageSize: Int!, $cursor: String) {
    organization(login: $login) {
      repositories(first: $pageSize, after: $cursor, orderBy: { field: NAME, direction: ASC }) {
        pageInfo {
          endCursor
          hasNextPage
          startCursor
        }
        nodes {
          ${REPO_STATS_FIELDS}
        }
      }
    }
  }
`;

/**
 * Query for fetching stats for a single repository by owner and name.
 */
export const SINGLE_REPO_STATS_QUERY = `
  query repoStats($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      ${REPO_STATS_FIELDS}
    }
  }
`;

/**
 * Deep pagination query for repository issues.
 * Used to fetch additional issue pages beyond the first page
 * returned by the main repo stats query.
 */
export const REPO_ISSUES_QUERY = `
  query repoIssues($owner: String!, $repo: String!, $pageSize: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      issues(first: $pageSize, after: $cursor) {
        pageInfo {
          endCursor
          hasNextPage
        }
        nodes {
          timeline {
            totalCount
          }
          comments {
            totalCount
          }
        }
      }
    }
  }
`;

/**
 * Deep pagination query for repository pull requests.
 * Used to fetch additional PR pages beyond the first page
 * returned by the main repo stats query.
 */
export const REPO_PULL_REQUESTS_QUERY = `
  query repoPullRequests($owner: String!, $repo: String!, $pageSize: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequests(first: $pageSize, after: $cursor) {
        pageInfo {
          endCursor
          hasNextPage
        }
        nodes {
          number
          timeline {
            totalCount
          }
          comments {
            totalCount
          }
          commits {
            totalCount
          }
          reviews(first: $pageSize) {
            totalCount
            nodes {
              comments {
                totalCount
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Deep pagination query for repository collaborators.
 * Used to fetch additional collaborator pages beyond the first page
 * returned by the main repo stats query. Retrieves permissionSources
 * to identify GitHub teams with admin access.
 */
export const REPO_COLLABORATORS_QUERY = `
  query repoCollaborators($owner: String!, $repo: String!, $pageSize: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      collaborators(first: $pageSize, after: $cursor) {
        pageInfo {
          endCursor
          hasNextPage
        }
        edges {
          permissionSources {
            permission
            source {
              ... on Team {
                slug
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Deep pagination query for team members within an organization.
 * Used to resolve the members of admin teams identified via collaborator analysis.
 */
export const TEAM_MEMBERS_QUERY = `
  query teamMembers($org: String!, $teamSlug: String!, $pageSize: Int!, $cursor: String) {
    organization(login: $org) {
      team(slug: $teamSlug) {
        members(first: $pageSize, after: $cursor) {
          pageInfo {
            endCursor
            hasNextPage
          }
          nodes {
            login
          }
        }
      }
    }
  }
`;

/**
 * Deep pagination query for SAML/SSO external identities in an organization.
 * Used to map GitHub logins to their SAML identity (nameId).
 * Will return null for samlIdentityProvider if the org does not have SAML configured.
 */
export const ORG_SAML_IDENTITIES_QUERY = `
  query orgSamlIdentities($org: String!, $pageSize: Int!, $cursor: String) {
    organization(login: $org) {
      samlIdentityProvider {
        externalIdentities(first: $pageSize, after: $cursor) {
          pageInfo {
            endCursor
            hasNextPage
          }
          nodes {
            user {
              login
            }
            samlIdentity {
              nameId
            }
          }
        }
      }
    }
  }
`;

/**
 * Lightweight query for listing repository names in an organization via GraphQL.
 * Only fetches the repo name and owner login — no stats or extra fields.
 * Used by project-stats to avoid REST API rate limits when iterating org repos.
 */
export const ORG_REPO_NAMES_QUERY = `
  query orgRepoNames($login: String!, $pageSize: Int!, $cursor: String) {
    organization(login: $login) {
      repositories(first: $pageSize, after: $cursor, orderBy: { field: NAME, direction: ASC }) {
        pageInfo {
          endCursor
          hasNextPage
        }
        nodes {
          name
          owner {
            login
          }
        }
      }
    }
  }
`;

/**
 * Query for counting ProjectsV2 linked to issues in a repository.
 * Paginates through issues and collects their linked projectsV2 nodes.
 * Also retrieves the total count of projects directly linked to the repository.
 *
 * Based on the approach from https://github.com/jcantosz/Count-repo-projects
 */
export const REPO_PROJECT_COUNTS_QUERY = `
  query repoProjectCounts($owner: String!, $repo: String!, $pageSize: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      issues(first: $pageSize, after: $cursor, states: [OPEN, CLOSED]) {
        pageInfo {
          endCursor
          hasNextPage
        }
        nodes {
          projectsV2(first: 100) {
            nodes {
              id
              number
              title
            }
          }
        }
      }
      projectsV2(first: 100) {
        totalCount
      }
    }
  }
`;

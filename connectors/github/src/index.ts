#!/usr/bin/env node
/**
 * GitHub MCP connector.
 *
 * Exposes a curated set of GitHub operations as MCP tools so an agent can
 * manage repositories, commit files, work with branches, open and merge PRs,
 * and work with issues on the user's behalf.
 *
 * Token resolution (see crypto.ts):
 *   - GITHUB_TOKEN_ENCRYPTED + OPENCODE_PASSPHRASE → decrypt at startup
 *   - GITHUB_TOKEN → use as-is
 *
 * The token requires at least the `repo` scope; add `delete_repo` for
 * repository deletion.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { resolveToken } from "./crypto.js";

let token: string;
let tokenSource: string;
try {
  const resolved = resolveToken(process.env);
  token = resolved.token;
  tokenSource = resolved.source;
} catch (err) {
  console.error((err as Error).message);
  console.error(
    "Hint: create a PAT at https://github.com/settings/tokens/new (scope: repo).",
  );
  process.exit(1);
}

const octokit = new Octokit({
  auth: token,
  userAgent: "opencode-connectors-github/0.1.0",
});

const server = new McpServer({
  name: "github-connector",
  version: "0.1.0",
});

function jsonText(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

// ----- Identity -----

server.tool(
  "whoami",
  "Return the authenticated GitHub user (login, id, html_url). Useful for sanity-checking that GITHUB_TOKEN is set correctly.",
  {},
  async () => {
    const { data } = await octokit.users.getAuthenticated();
    return jsonText({
      login: data.login,
      id: data.id,
      name: data.name,
      html_url: data.html_url,
      public_repos: data.public_repos,
      total_private_repos: data.total_private_repos,
    });
  },
);

// ----- Repositories -----

server.tool(
  "list_repos",
  "List repositories for the authenticated user.",
  {
    visibility: z.enum(["all", "public", "private"]).default("all"),
    affiliation: z
      .string()
      .default("owner")
      .describe(
        "Comma-separated list of one or more of: owner, collaborator, organization_member.",
      ),
    sort: z
      .enum(["created", "updated", "pushed", "full_name"])
      .default("updated"),
    per_page: z.number().int().min(1).max(100).default(30),
  },
  async ({ visibility, affiliation, sort, per_page }) => {
    const { data } = await octokit.repos.listForAuthenticatedUser({
      visibility,
      affiliation,
      sort,
      per_page,
    });
    return jsonText(
      data.map((r) => ({
        full_name: r.full_name,
        private: r.private,
        description: r.description,
        html_url: r.html_url,
        default_branch: r.default_branch,
        updated_at: r.updated_at,
      })),
    );
  },
);

server.tool(
  "get_repo",
  "Get metadata for a repository.",
  {
    owner: z.string(),
    repo: z.string(),
  },
  async ({ owner, repo }) => {
    const { data } = await octokit.repos.get({ owner, repo });
    return jsonText({
      full_name: data.full_name,
      private: data.private,
      description: data.description,
      html_url: data.html_url,
      default_branch: data.default_branch,
      clone_url: data.clone_url,
      ssh_url: data.ssh_url,
      created_at: data.created_at,
      updated_at: data.updated_at,
      open_issues_count: data.open_issues_count,
      stargazers_count: data.stargazers_count,
    });
  },
);

server.tool(
  "create_repo",
  "Create a new repository owned by the authenticated user.",
  {
    name: z.string().describe("Repository name (no owner prefix)."),
    description: z.string().optional(),
    private: z.boolean().default(true),
    auto_init: z
      .boolean()
      .default(true)
      .describe("Initialize with an empty README so the default branch exists."),
    has_issues: z.boolean().default(true),
    has_wiki: z.boolean().default(false),
    has_projects: z.boolean().default(false),
  },
  async (args) => {
    const { data } = await octokit.repos.createForAuthenticatedUser(args);
    return jsonText({
      full_name: data.full_name,
      private: data.private,
      html_url: data.html_url,
      clone_url: data.clone_url,
      default_branch: data.default_branch,
    });
  },
);

server.tool(
  "delete_repo",
  "Delete a repository. DESTRUCTIVE. Requires the delete_repo scope on the token. Always confirm with the user before calling.",
  {
    owner: z.string(),
    repo: z.string(),
  },
  async ({ owner, repo }) => {
    await octokit.repos.delete({ owner, repo });
    return jsonText({ deleted: `${owner}/${repo}` });
  },
);

// ----- Files / commits -----

server.tool(
  "get_file",
  "Read a file from a repository. Returns decoded UTF-8 content plus the blob SHA (needed for updates).",
  {
    owner: z.string(),
    repo: z.string(),
    path: z.string().describe("Path relative to the repo root, e.g. 'src/index.ts'."),
    ref: z
      .string()
      .optional()
      .describe("Branch name, tag, or commit SHA. Defaults to the default branch."),
  },
  async ({ owner, repo, path, ref }) => {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data)) {
      throw new Error(`Path '${path}' is a directory, not a file.`);
    }
    if (data.type !== "file") {
      throw new Error(`Path '${path}' is a ${data.type}, not a file.`);
    }
    const content =
      data.encoding === "base64"
        ? Buffer.from(data.content, "base64").toString("utf-8")
        : data.content;
    return jsonText({
      path: data.path,
      sha: data.sha,
      size: data.size,
      encoding: data.encoding,
      content,
    });
  },
);

server.tool(
  "create_or_update_file",
  "Commit a single file to a branch. Creates the file if it doesn't exist; otherwise updates it (sha is required to update).",
  {
    owner: z.string(),
    repo: z.string(),
    path: z.string(),
    content: z.string().describe("UTF-8 file content."),
    message: z.string().describe("Commit message."),
    branch: z
      .string()
      .optional()
      .describe("Target branch. Defaults to the repo's default branch."),
    sha: z
      .string()
      .optional()
      .describe(
        "Blob SHA of the existing file. REQUIRED when updating an existing file (get it from get_file).",
      ),
  },
  async ({ owner, repo, path, content, message, branch, sha }) => {
    const { data } = await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      message,
      content: Buffer.from(content, "utf-8").toString("base64"),
      branch,
      sha,
    });
    return jsonText({
      commit_sha: data.commit.sha,
      commit_url: data.commit.html_url,
      content_path: data.content?.path,
      content_sha: data.content?.sha,
    });
  },
);

server.tool(
  "delete_file",
  "Delete a file via a commit. DESTRUCTIVE. Requires the blob SHA — fetch it with get_file first.",
  {
    owner: z.string(),
    repo: z.string(),
    path: z.string(),
    message: z.string(),
    sha: z.string().describe("Blob SHA of the file (from get_file)."),
    branch: z.string().optional(),
  },
  async ({ owner, repo, path, message, sha, branch }) => {
    const { data } = await octokit.repos.deleteFile({
      owner,
      repo,
      path,
      message,
      sha,
      branch,
    });
    return jsonText({
      commit_sha: data.commit.sha,
      commit_url: data.commit.html_url,
    });
  },
);

// ----- Branches -----

server.tool(
  "list_branches",
  "List branches in a repository.",
  {
    owner: z.string(),
    repo: z.string(),
    per_page: z.number().int().min(1).max(100).default(30),
  },
  async ({ owner, repo, per_page }) => {
    const { data } = await octokit.repos.listBranches({ owner, repo, per_page });
    return jsonText(
      data.map((b) => ({
        name: b.name,
        protected: b.protected,
        commit_sha: b.commit.sha,
      })),
    );
  },
);

server.tool(
  "create_branch",
  "Create a new branch from another branch's HEAD commit.",
  {
    owner: z.string(),
    repo: z.string(),
    new_branch: z.string().describe("Name of the branch to create."),
    from_branch: z
      .string()
      .optional()
      .describe("Source branch. Defaults to the repo's default branch."),
  },
  async ({ owner, repo, new_branch, from_branch }) => {
    let source = from_branch;
    if (!source) {
      const { data: r } = await octokit.repos.get({ owner, repo });
      source = r.default_branch;
    }
    const { data: ref } = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${source}`,
    });
    const { data } = await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${new_branch}`,
      sha: ref.object.sha,
    });
    return jsonText({
      ref: data.ref,
      sha: data.object.sha,
      from: source,
    });
  },
);

// ----- Pull requests -----

server.tool(
  "list_pulls",
  "List pull requests in a repository.",
  {
    owner: z.string(),
    repo: z.string(),
    state: z.enum(["open", "closed", "all"]).default("open"),
    per_page: z.number().int().min(1).max(100).default(30),
  },
  async ({ owner, repo, state, per_page }) => {
    const { data } = await octokit.pulls.list({ owner, repo, state, per_page });
    return jsonText(
      data.map((p) => ({
        number: p.number,
        title: p.title,
        state: p.state,
        draft: p.draft,
        user: p.user?.login,
        head: p.head.ref,
        base: p.base.ref,
        html_url: p.html_url,
        created_at: p.created_at,
      })),
    );
  },
);

server.tool(
  "create_pull",
  "Open a pull request.",
  {
    owner: z.string(),
    repo: z.string(),
    title: z.string(),
    head: z.string().describe("Source branch (the branch with your changes)."),
    base: z.string().describe("Target branch to merge into."),
    body: z.string().optional(),
    draft: z.boolean().default(false),
  },
  async ({ owner, repo, title, head, base, body, draft }) => {
    const { data } = await octokit.pulls.create({
      owner,
      repo,
      title,
      head,
      base,
      body,
      draft,
    });
    return jsonText({
      number: data.number,
      html_url: data.html_url,
      state: data.state,
      draft: data.draft,
    });
  },
);

server.tool(
  "merge_pull",
  "Merge a pull request. DESTRUCTIVE-ish — confirm with the user first.",
  {
    owner: z.string(),
    repo: z.string(),
    pull_number: z.number().int(),
    merge_method: z.enum(["merge", "squash", "rebase"]).default("squash"),
    commit_title: z.string().optional(),
    commit_message: z.string().optional(),
  },
  async ({ owner, repo, pull_number, merge_method, commit_title, commit_message }) => {
    const { data } = await octokit.pulls.merge({
      owner,
      repo,
      pull_number,
      merge_method,
      commit_title,
      commit_message,
    });
    return jsonText({
      merged: data.merged,
      sha: data.sha,
      message: data.message,
    });
  },
);

// ----- Issues -----

server.tool(
  "list_issues",
  "List issues in a repository. Note: GitHub returns PRs in this endpoint too — filter by has_pull_request if you want only issues.",
  {
    owner: z.string(),
    repo: z.string(),
    state: z.enum(["open", "closed", "all"]).default("open"),
    per_page: z.number().int().min(1).max(100).default(30),
  },
  async ({ owner, repo, state, per_page }) => {
    const { data } = await octokit.issues.listForRepo({
      owner,
      repo,
      state,
      per_page,
    });
    return jsonText(
      data.map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        user: i.user?.login,
        labels: i.labels.map((l) => (typeof l === "string" ? l : l.name)),
        html_url: i.html_url,
        is_pull_request: Boolean(i.pull_request),
      })),
    );
  },
);

server.tool(
  "create_issue",
  "Create an issue.",
  {
    owner: z.string(),
    repo: z.string(),
    title: z.string(),
    body: z.string().optional(),
    labels: z.array(z.string()).optional(),
    assignees: z.array(z.string()).optional(),
  },
  async ({ owner, repo, title, body, labels, assignees }) => {
    const { data } = await octokit.issues.create({
      owner,
      repo,
      title,
      body,
      labels,
      assignees,
    });
    return jsonText({
      number: data.number,
      html_url: data.html_url,
      state: data.state,
    });
  },
);

server.tool(
  "comment_on_issue",
  "Post a comment on an issue or pull request (PRs are issues in the GitHub API).",
  {
    owner: z.string(),
    repo: z.string(),
    issue_number: z.number().int(),
    body: z.string(),
  },
  async ({ owner, repo, issue_number, body }) => {
    const { data } = await octokit.issues.createComment({
      owner,
      repo,
      issue_number,
      body,
    });
    return jsonText({
      id: data.id,
      html_url: data.html_url,
    });
  },
);

// ----- Boot -----

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `github-connector MCP server running on stdio (token from ${tokenSource})`,
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

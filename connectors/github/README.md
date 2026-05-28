# GitHub connector

An MCP connector that lets an AI agent manage GitHub on your behalf — create and delete repositories, read and commit files, manage branches, open and merge pull requests, and work with issues.

## Setup

1. **Create a Personal Access Token (PAT)** at https://github.com/settings/tokens/new with at minimum the `repo` scope. Add `delete_repo` if you want the agent to be able to delete repositories, and `workflow` if it should edit Actions workflows.

2. **Export it** as `GITHUB_TOKEN` in your shell:

   ```bash
   export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

3. **Wire it into OpenCode** in your `opencode.json`:

   ```json
   {
     "mcp": {
       "github": {
         "type": "local",
         "command": ["node", "./connectors/github/dist/index.js"],
         "enabled": true,
         "environment": {
           "GITHUB_TOKEN": "${GITHUB_TOKEN}"
         }
       }
     }
   }
   ```

4. **Build:**

   ```bash
   npm install                            # from the repo root
   npm run build --workspace=connectors/github
   ```

## Tools

### Repositories

- **`whoami`** — Returns the authenticated user (a quick check that the token works).
- **`list_repos`** — List repositories for the authenticated user. Args: `visibility` ("all" | "public" | "private"), `affiliation`, `sort`, `per_page`.
- **`get_repo`** — Get metadata for `owner/repo`.
- **`create_repo`** — Create a new repository under the authenticated user. Args: `name`, `description?`, `private?` (default `true`), `auto_init?` (default `true`).
- **`delete_repo`** — Delete `owner/repo`. **Destructive — requires `delete_repo` scope.**

### Files (commits)

- **`get_file`** — Read a file from a repo. Args: `owner`, `repo`, `path`, `ref?` (branch / tag / SHA).
- **`create_or_update_file`** — Commit a single file (creates or updates it). Args: `owner`, `repo`, `path`, `content` (UTF-8 string), `message`, `branch?`, `sha?` (required when updating).
- **`delete_file`** — Delete a file via the Contents API (creates a commit). Args: `owner`, `repo`, `path`, `message`, `sha`, `branch?`.

### Branches

- **`list_branches`** — List branches in `owner/repo`.
- **`create_branch`** — Create a new branch from another branch's HEAD. Args: `owner`, `repo`, `new_branch`, `from_branch?` (default: the repo's default branch).

### Pull requests

- **`list_pulls`** — List PRs. Args: `owner`, `repo`, `state?` ("open" | "closed" | "all").
- **`create_pull`** — Open a PR. Args: `owner`, `repo`, `title`, `head` (source branch), `base` (target branch), `body?`, `draft?`.
- **`merge_pull`** — Merge a PR. Args: `owner`, `repo`, `pull_number`, `merge_method?` ("merge" | "squash" | "rebase").

### Issues

- **`list_issues`** — List issues in a repo. Args: `owner`, `repo`, `state?`.
- **`create_issue`** — Create an issue. Args: `owner`, `repo`, `title`, `body?`, `labels?`, `assignees?`.
- **`comment_on_issue`** — Post a comment. Args: `owner`, `repo`, `issue_number`, `body`. Works for both issues and PRs (PRs are issues in the GitHub API).

## Notes

- All tools return JSON-stringified output so the agent can read and reference fields.
- The token is read once at startup. If you rotate it, restart the connector.
- Destructive tools (`delete_repo`, `delete_file`, `merge_pull`) succeed silently when they work — the agent should confirm with the user before calling them.
- Rate limits: authenticated requests get 5,000/hr. The connector surfaces the underlying GitHub error if you hit the limit.

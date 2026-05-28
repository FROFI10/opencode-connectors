# GitHub connector

An MCP connector that lets an AI agent manage GitHub on your behalf — create and delete repositories, read and commit files, manage branches, open and merge pull requests, and work with issues.

## Setup

The token in [`opencode.json`](../../opencode.json) at the repo root is **encrypted** with a master passphrase (AES-256-GCM, scrypt KDF). The connector decrypts it at startup using the `OPENCODE_PASSPHRASE` environment variable.

### Fast path — `setup.ps1`

From the repo root, run:

```powershell
./setup.ps1
```

It installs deps, builds, prompts for the master passphrase, optionally saves it to your PowerShell profile, and verifies the token decrypts. After that, OpenCode in this folder will just work.

### Manual path

```bash
npm install
npm run build
```

Then set the passphrase in your shell each session (or in your PowerShell profile / `.bashrc` to make it permanent):

```powershell
$env:OPENCODE_PASSPHRASE = "your-master-passphrase"
```

```bash
export OPENCODE_PASSPHRASE="your-master-passphrase"
```

Then start OpenCode in this folder — it picks up `opencode.json` automatically.

## Token modes

The connector supports two ways to provide the token, checked in this order:

1. **Encrypted (recommended).** `GITHUB_TOKEN_ENCRYPTED` + `OPENCODE_PASSPHRASE` — the encrypted blob lives in `opencode.json` (safe to commit), the passphrase lives only in your environment.
2. **Plaintext.** `GITHUB_TOKEN` — straightforward but the token is in cleartext wherever you set it.

If `GITHUB_TOKEN_ENCRYPTED` is set, `GITHUB_TOKEN` is ignored.

### Rotating or re-encrypting the token

If you need to put a new token in (e.g. you regenerated the PAT on GitHub):

```bash
npm run encrypt-token
```

It prompts (masked) for the new token and your master passphrase, and prints the encrypted string. Paste it into `opencode.json` under `mcp.github.environment.GITHUB_TOKEN_ENCRYPTED`.

If you want a fresh master passphrase too, just use a new one when prompted — the script doesn't care about the old one.

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

---
name: auto-push-github
description: Publish a completed project to an existing GitHub repository by staging, committing, and pushing with Git. Use when the user wants a finished project uploaded to GitHub without opening the GitHub website or using the GitHub CLI.
---

# Auto Push GitHub

Use this skill after the project's acceptance checks pass, or when the user explicitly asks to publish the current project.

The skill publishes through the local `git` command. It does not require `gh`, does not open a browser, does not create a GitHub repository, and does not create a pull request.

## Required Setup

The project must already be a Git repository with a GitHub remote. One-time setup is done outside this skill:

```powershell
git remote add origin https://github.com/<owner>/<repo>.git
```

The remote may be named `origin` or another name. Existing Git credentials must be available to the local credential helper.

## Publish Workflow

Run the helper from the project directory:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish.ps1
```

When the script is installed as a Codex skill, use its absolute path:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\.codex\skills\auto-push-github\scripts\publish.ps1"
```

The helper:

- finds the Git repository root;
- selects the configured GitHub remote;
- stages all non-ignored project changes;
- creates one commit when there are changes;
- pushes the current branch and sets its upstream when needed;
- stops on authentication errors, non-fast-forward pushes, detached HEAD, missing remotes, or secret-like files.

Never replace the helper with `git push --force`, `git reset --hard`, or a pull/rebase that rewrites the working tree. If the push is rejected because the remote has newer commits, stop and report that a human decision is needed.

## Options

Use a custom commit message when the user provides one:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\王\.codex\skills\auto-push-github\scripts\publish.ps1" -Message "feat: complete project"
```

Preview without changing files or pushing:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\王\.codex\skills\auto-push-github\scripts\publish.ps1" -DryRun
```

When the repository contains unrelated unfinished work, publish only the completed directory:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\.codex\skills\auto-push-github\scripts\publish.ps1" -Paths "skills\auto-push-github"
```

`-Paths` is relative to the repository root and may be supplied multiple times. The helper refuses to run when the Git index already contains staged changes, so it cannot accidentally include unrelated staged work.

When publishing from a temporary local branch, push the current branch to a different remote branch:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\.codex\skills\auto-push-github\scripts\publish.ps1" -TargetBranch "main"
```

If the user explicitly confirms that a detected secret-like file is intended to be published, pass `-AllowSensitive`. Do not use this switch merely to get past an error.

## Reporting

After a successful run, report the repository root, remote name, branch, commit hash, and push result. If the script cannot publish, report the exact blocker and the one-time action needed; do not claim the upload succeeded.

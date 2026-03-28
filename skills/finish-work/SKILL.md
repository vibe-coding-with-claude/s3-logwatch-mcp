---
name: finish-work
description: Complete current work by committing changes, creating a PR to dev, and linking the issue. Use when work is ready for review.
---

# Finish Work Skill

Automate the workflow of completing and submitting a development work for review.

## What This Skill Does

1. **Review Changes**: Show git status and diff summary
2. **Create Commit**: Commit all changes with a conventional commit message
3. **Push Branch**: Push the branch to remote
4. **Create PR**: Open a pull request to `dev` branch
5. **Link Issue**: Automatically link the related GitHub issue
6. **Update Status**: Provide PR URL for tracking

## Usage

```
/finish-work [optional: custom commit message]
```

## Examples

```
/finish-work
→ Reviews changes
→ Commits with auto-generated message
→ Creates PR to dev with issue linked

/finish-work Custom commit message here
→ Uses your custom message instead
```

## Instructions

When the user invokes this skill:

1. **Check current branch**:
   - Get current branch name: `git branch --show-current`
   - Extract issue number from branch name (e.g., `feature/123-...` → `123`)
   - If not on a feature/fix branch, ask user to confirm
2. **Review changes**:
   - Run `git status` to show modified files
   - Run `git diff --stat` to show change summary
   - Display summary to user
3. **Determine commit message**:
   - If user provided custom message: use it
   - If not: generate from branch name and issue title
   - Format: `<type>: <description> (#<issue>)`
   - Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`
4. **Stage and commit**:
   - Run `git add -A` to stage all changes
   - Run `git commit -m "<message>"`
   - Include co-authored-by: `Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>`
5. **Push to remote**:
   - Run `git push -u origin <branch-name>`
6. **Create pull request**:
   - Run `gh pr create --base dev --title "<PR title>" --body "<PR body>"`
   - PR title: Same as commit message (without issue number)
   - PR body format:
     ```
     ## Summary
     <Brief description of changes>

     ## Related Issue
     Closes #<issue-number>

     ## Changes
     <List of key changes from git diff>

     🤖 Generated with Claude Code
     ```
7. **Confirm to user**:
   - Display PR URL
   - Display branch name
   - Display linked issue
   - Suggest next steps (review, testing, etc.)

## Commit Message Format

| Branch Type | Commit Type | Example |
|-------------|-------------|---------|
| `feature/123-add-auth` | `feat` | `feat: add user authentication (#123)` |
| `fix/124-login-bug` | `fix` | `fix: resolve login page bug (#124)` |
| `feature/125-refactor-api` | `refactor` | `refactor: restructure API layer (#125)` |

## PR Body Template

```markdown
## Summary
[Auto-generated summary of what was changed]

## Related Issue
Closes #[issue-number]

## Changes
- [List of modified files and key changes]

## Test Plan
- [ ] Manual testing completed
- [ ] Unit tests pass
- [ ] Integration tests pass

🤖 Generated with Claude Code
```

## Error Handling

- If no changes to commit: Display message and exit gracefully
- If not on feature/fix branch: Warn user and ask for confirmation
- If push fails: Display error and suggest checking remote access
- If PR creation fails: Display error, note that commit was successful
- If issue number not found: Create PR without issue link, notify user

## Notes

- All PRs target `dev` branch (not `main`)
- Automatically links GitHub issue via "Closes #X" in PR body
- Includes Claude co-author attribution in commit
- PR can be reviewed and merged through normal GitHub workflow
- Original issue will auto-close when PR is merged

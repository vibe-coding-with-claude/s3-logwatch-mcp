---
name: commit
description: Create a git commit with conventional commit message format. Use when you want to save progress without creating a PR.
---

# Commit Skill

Create well-formatted git commits following conventional commit standards.

## What This Skill Does

1. **Review Changes**: Show what files have been modified
2. **Generate Message**: Create a conventional commit message
3. **Commit Changes**: Stage and commit with proper formatting
4. **Confirm**: Display commit details

## Usage

```
/commit [optional: custom message]
```

## Examples

```
/commit
→ Reviews changes
→ Auto-generates commit message
→ Creates commit with Co-Authored-By attribution

/commit Add validation to login form
→ Uses your custom message
→ Creates commit with proper formatting
```

## Instructions

When the user invokes this skill:

1. **Review changes**:
   - Run `git status` to list modified files
   - Run `git diff --stat` to show change statistics
   - Display summary to user
2. **Check for changes**:
   - If no changes: Display "No changes to commit" and exit
   - If changes exist: Proceed to commit
3. **Determine commit message**:
   - If user provided custom message: use it as the subject line
   - If not: analyze the changes and generate appropriate message
   - Follow conventional commit format: `<type>: <description>`
4. **Determine commit type**:
   - `feat`: New feature or functionality added
   - `fix`: Bug fix or error correction
   - `refactor`: Code restructuring without behavior change
   - `docs`: Documentation changes only
   - `test`: Adding or modifying tests
   - `chore`: Build, config, or maintenance tasks
   - `style`: Formatting, whitespace, etc.
5. **Stage and commit**:
   - Run `git add -A` to stage all changes
   - Create commit message with Co-Authored-By line
   - Run commit with heredoc format:
     ```bash
     git commit -m "$(cat <<'EOF'
     <type>: <description>

     Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
     EOF
     )"
     ```
6. **Confirm to user**:
   - Display commit hash
   - Display commit message
   - Display files committed
   - Remind: "Changes committed locally (not pushed)"

## Commit Type Guidelines

| Type | When to Use | Example |
|------|-------------|---------|
| `feat` | Add new functionality | `feat: add email validation` |
| `fix` | Fix a bug or error | `fix: resolve null pointer in handler` |
| `refactor` | Restructure code | `refactor: extract auth logic to helper` |
| `docs` | Update documentation | `docs: update API endpoint docs` |
| `test` | Add or modify tests | `test: add unit tests for validator` |
| `chore` | Config, deps, tooling | `chore: update eslint config` |
| `style` | Formatting only | `style: format with prettier` |

## Message Guidelines

- **Keep it concise**: Subject line under 70 characters
- **Use imperative mood**: "add" not "added" or "adds"
- **Be specific**: "add email validation" not "update code"
- **No period at end**: Subject line doesn't need punctuation
- **Lowercase subject**: Start with lowercase letter

### Good Examples
```
feat: add user authentication
fix: resolve login redirect loop
refactor: extract database queries to repository
docs: add API usage examples
```

### Bad Examples
```
Updated stuff.
Fixed bug
WIP
feat: Added the new user authentication feature with JWT.
```

## Error Handling

- If no git repository: Display error and exit
- If no changes to commit: Display message and exit gracefully
- If commit fails: Display git error message
- If user on detached HEAD: Warn but allow commit

## Notes

- This skill only commits locally (does not push to remote)
- To push and create PR, use `/finish-work` instead
- To start new work with issue tracking, use `/start-work`
- Commits include Claude co-author attribution
- All changes are staged with `git add -A`

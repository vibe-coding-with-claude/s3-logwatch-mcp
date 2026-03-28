---
name: start-work
description: Start a new work by creating a GitHub issue and feature/fix branch from dev. Use when beginning new work on a feature or bug fix.
---

# Start Work Skill

Automate the workflow of starting a new development work.

## What This Skill Does

1. **Create GitHub Issue**: Generate an issue with the task description
2. **Create Branch**: Create a branch from `dev` with the issue number, using the same prefix as the issue type (e.g., `feature/`, `fix/`, `docs/`, `chore/`)
3. **Switch Branch**: Automatically checkout to the new branch
4. **Ready to Work**: Environment is set up and ready for development

## Usage

```
/start-work <task description>
```

## Examples

```
/start-work Add user authentication API with JWT tokens and refresh token support
→ Creates issue #123: "feat: User authentication"
→ Issue body includes structured template with task breakdown
→ Creates branch: feature/123
→ Switches to new branch

/start-work Fix login page redirect bug after successful authentication
→ Creates issue #124: "fix: Login redirect"
→ Issue body includes structured template with task breakdown
→ Creates branch: fix/124
→ Switches to new branch

/start-work Implement payment processing with Stripe integration
→ Creates issue #125: "feat: Stripe payment integration"
→ Issue body includes structured template with task breakdown
→ Creates branch: feature/125
→ Switches to new branch
```

## Instructions

When the user invokes this skill:

1. **Parse the task description** from the user's input
2. **Generate concise issue title**:
   - Analyze task description and summarize it into 3-5 words
   - Keep the core meaning but make it short and clear
   - Example: "Implement payment processing with Stripe" → "Stripe payment integration"
   - Example: "Add user authentication with JWT tokens" → "User authentication"
3. **Determine commit type and add Conventional Commits prefix**:
   - Analyze task description keywords to determine the appropriate prefix
   - Add the prefix to the summarized issue title
   - Prefix mapping (see table below for details)
4. **Determine branch type**:
   - Use the same prefix word as the issue type (see table below)
   - `feat:` → `feature/`, `fix:` → `fix/`, `docs:` → `docs/`, `refactor:` → `refactor/`, `test:` → `test/`, `chore:` → `chore/`
   - When unclear, default to `feature/`
5. **Create issue body with structured template**:
   - Use the following markdown template structure:
   ```markdown
   ## 작업 설명
   [Expand on the user's task description with context and goals]

   ## 작업 항목
   - [ ] [Break down into specific actionable tasks]
   - [ ] [Add 2-4 concrete checkboxes based on the task]

   ## 참고사항
   - 생성 시각: [Current timestamp]
   - 생성 방법: /start-work 스킬
   ```
6. **Create GitHub issue**:
   - Use `gh issue create --title "<prefix>: <summarized title>" --body "<structured template>"`
   - Capture the issue number from the output
7. **Ensure on dev branch**:
   - Run `git checkout dev`
   - Run `git pull origin dev` to sync latest changes
8. **Create new branch**:
   - Format: `<branch-prefix>/<issue-number>`
   - Example: `feature/123`, `fix/124`, `docs/125`, `chore/126`
   - Run `git checkout -b <branch-name>`
9. **Confirm to user**:
   - Display issue number and URL
   - Display branch name
   - Confirm ready to start work

## Commit Type Prefix Rules

Analyze the task description and apply the appropriate Conventional Commits prefix:

| Commit Type | Keywords (EN/KR) | Issue Prefix | Branch Prefix |
|-------------|------------------|--------------|---------------|
| Feature | add, create, implement, build, develop, research / 추가, 생성, 구현, 개발, 연구, 정의 | `feat:` | `feature/` |
| Fix | fix, resolve, repair, correct, patch / 수정, 해결, 고치다, 패치 | `fix:` | `fix/` |
| Documentation | docs, documentation, readme / 문서, 도큐먼트 | `docs:` | `docs/` |
| Refactor | refactor, restructure, reorganize, improve / 리팩토링, 재구성, 개선 | `refactor:` | `refactor/` |
| Test | test, testing, unit test, e2e / 테스트 | `test:` | `test/` |
| Chore | build, ci, dependency, config / 빌드, 설정, 의존성 | `chore:` | `chore/` |

**Default**: When unclear, use `feat:` prefix

## Error Handling

- If `gh` CLI is not installed: Ask user to install GitHub CLI
- If not in a git repository: Display error and exit
- If `dev` branch doesn't exist: Ask user to create it first
- If network error: Display error and suggest retrying

## Notes

- All branches are created from `dev` (not `main`)
- Issue is created in the current repository with Conventional Commits prefix
- Branch name automatically includes issue number for traceability
- Task description should be concise but descriptive (3-10 words ideal)
- Supports both English and Korean keywords for commit type detection
- Issue titles follow Conventional Commits format: `<type>: <description>`

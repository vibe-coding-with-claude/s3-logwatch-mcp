---
name: spec-formatter
description: Transform raw functional specification notes into structured, consistent markdown documents. Use when user provides feature spec content and wants it formatted as a clean specification document.
---

# Spec Formatter Skill

Transform raw functional specification content into structured markdown documents.

**Rules:**
- Document content in Korean (한글), Skill metadata in English
- Filename: `{feature-name}.md` (e.g., `url-access-control.md`), saved under `docs/plan/specs/{domain}/`
- Preserve all original information — restructure, never omit

## Document Structure

```markdown
# 기능명

> One-line summary of purpose (optional — omit if no clear overview exists)

## Section(s)
(feature-specific content)

## 예외 처리          ← ALWAYS present
## 참조              ← if screen designs or related docs exist
```

## Formatting Rules

| Element | Format | Example |
|---------|--------|---------|
| Overview | `>` blockquote, 1-2 lines max | `> 비인가 데이터 접근을 원천 차단한다.` |
| Numeric specs | Table with columns | 최대 개수, 크기 제한 등 |
| Review needed | `> [!WARNING]` alert | `> [!WARNING]` 개발팀 검토 필요 |
| Content TBD | `> [!NOTE]` alert | `> [!NOTE]` 내용 추가 예정 |
| Identifiers | Inline code | \`userId\`, \`401\` |
| Alert codes | Bold | **ERR-001** |
| Exception handling | Table: 상황 / 응답 or 처리 | Always a dedicated section |
| References | Bullet list at bottom | `- 화면 설계: UI-01-01` |

## Diagrams

Use diagrams when the feature involves sequential flow, branching, or state changes.

- **Mermaid flowchart** for multi-step processes with branches
- **Text diagram** (`→`, `├─`, `└─`) for simple linear flows
- Do NOT add diagrams for pure rule/policy specs (no flow to visualize)

## Guidelines

- **No forced sections**: Only include sections that have content. Skip overview if none provided.
- **Always include**: 예외 처리 section, even if marked as TBD
- **Tables over prose**: If content has 2+ comparable items with shared attributes, use a table
- **Group by concern**: Split sub-features into `###` subsections within the main spec
- **Scope markers**: When phased rollout exists (1차/차기), note it right under the overview

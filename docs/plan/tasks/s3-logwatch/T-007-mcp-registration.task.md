# Task: Claude Code에 MCP Server 등록

> **Spec:** docs/s3-logwatch-tech-decisions.md#4-질의-동작-flow
> **Priority:** 🔴 P0 — 등록 안 하면 Claude Code가 도구를 인식 못 함
> **Status:** done
> **Depends on:** T-001

## Context
MCP Server를 만들어도 Claude Code에 등록하지 않으면 사용할 수 없다.
`.claude/settings.local.json` 또는 `~/.claude.json`에 서버 경로를 등록해야
Claude Code가 자식 프로세스로 서버를 실행하고 도구를 인식한다.

## be
- [ ] Claude Code MCP 설정에 s3-logwatch 서버 등록
  - command: node 또는 tsx
  - args: src/index.ts 경로
- [ ] 등록 후 Claude Code에서 도구 목록 노출 확인

## qa
- [ ] Claude Code 재시작 후 s3-logwatch 서버 자동 연결됨
- [ ] 등록된 도구 목록이 Claude Code에서 보임

# Task: s3-logwatch 프로젝트 초기 설정

> **Spec:** docs/s3-logwatch-tech-decisions.md#12-프로젝트-구조
> **Priority:** 🔴 P0 — 다른 모든 작업의 전제 조건
> **Status:** done

## Context
MCP Server 개발을 시작하려면 TypeScript 프로젝트 구조가 먼저 필요하다.
사용자는 TS와 MCP 서버 개발이 처음이므로, 각 설정 파일의 역할을 설명해야 한다.

## be
- [ ] `mcp-server/` 디렉토리 생성
- [ ] `package.json` 초기화 (name, scripts, dependencies)
  - `@modelcontextprotocol/sdk` — MCP 공식 SDK
  - `@aws-sdk/client-s3`, `@aws-sdk/client-athena`, `@aws-sdk/client-firehose`, `@aws-sdk/client-glue`, `@aws-sdk/client-iam` — AWS 서비스 연동
  - `typescript`, `tsx` — TS 컴파일/실행
  - `yaml` — config.yaml 파싱
- [ ] `tsconfig.json` 설정 (strict mode, ESM, target 등)
- [ ] `src/index.ts` — MCP Server 진입점 (빈 서버, stdio transport)
- [ ] `src/tools/` 디렉토리 구조 생성
- [ ] Claude Code에서 MCP Server로 연결 테스트 (빈 서버가 뜨는지 확인)

## qa
- [ ] `npm install` 성공
- [ ] `npx tsc --noEmit` 성공 (타입 에러 없음)
- [ ] Claude Code에서 MCP Server 연결 시 에러 없이 초기화됨

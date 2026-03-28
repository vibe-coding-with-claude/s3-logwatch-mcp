# Task: athena-query 도구 구현

> **Spec:** docs/s3-logwatch-tech-decisions.md#4-질의-동작-flow
> **Priority:** 🟠 P1 — 핵심 사용자 경험 (자연어로 로그 분석)
> **Status:** done
> **Depends on:** T-003

## Context
사용자가 "오늘 payment 도메인에서 에러가 얼마나 발생했어?"라고 물으면
Claude Code가 이 도구를 호출하여 Athena SQL을 실행하고 결과를 반환한다.
테이블 스키마와 파티션 구조가 설정에 내장되어 있어 최적 쿼리가 보장된다.

## be
- [ ] `src/tools/query.ts` — `athena-query` MCP 도구 구현
- [ ] 입력: SQL 쿼리 문자열
- [ ] Athena StartQueryExecution → GetQueryExecution (폴링) → GetQueryResults
- [ ] 결과에 스캔량(bytes) + 예상 비용($5/TB 기준) 자동 첨부
- [ ] 쿼리 타임아웃 설정 (config 또는 기본값)
- [ ] 쿼리 실행 비용을 누적 추적 (세션 내)

## qa
- [ ] 단순 SELECT 쿼리 실행 + 결과 반환 확인
- [ ] 파티션 필터 쿼리 (WHERE level='ERROR') 동작 확인
- [ ] 스캔량/비용 표시 확인
- [ ] 잘못된 SQL 입력 시 에러 메시지 확인

# Task: E2E 테스트 (로그 수집 → 쿼리 전체 흐름)

> **Spec:** docs/s3-logwatch-tech-decisions.md#2, #4
> **Priority:** 🟡 P2 — 모든 도구 완성 후 전체 흐름 검증
> **Status:** done
> **Depends on:** T-003, T-004, T-005, T-006, T-007

## Context
개별 도구가 동작해도 전체 파이프라인이 연결되는지는 별도 검증이 필요하다.
실제 CloudWatch 로그가 S3에 Parquet으로 적재되고, Athena로 쿼리되는 흐름을 확인한다.

## qa
- [ ] init-infra → AWS 리소스 생성 확인
- [ ] connect-log-group → 테스트용 Log Group 연결
- [ ] 테스트 로그 발생 → Firehose → S3 Parquet 적재 확인
  - Firehose 버퍼 시간(기본 300초) 대기 후 S3에 파일 존재 확인
- [ ] athena-query → S3에 적재된 로그 쿼리 성공
  - 파티션 필터 (WHERE level='ERROR') 동작 확인
- [ ] get-cost → 쿼리 비용 누적 확인
- [ ] 전체 흐름을 Claude Code 자연어 대화로 수행 가능 확인

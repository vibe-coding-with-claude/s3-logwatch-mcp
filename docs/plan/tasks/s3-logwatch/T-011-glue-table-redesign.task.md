# Task: Glue 테이블 재설계 — 도메인별 경로 + 날짜 파티셔닝

> **Spec:** docs/s3-logwatch-tech-decisions.md#3
> **Priority:** 🔴 P0 — Athena 쿼리의 전제
> **Status:** done
> **Depends on:** T-009

## Context
S3 경로가 `seungjae/{domain}/2026/03/28/`로 변경되므로 Glue 테이블의 파티션 구조도 맞춰야 한다.
Partition Projection으로 MSCK REPAIR TABLE 없이 자동 인식.

## be
- [ ] `src/tools/init.ts`의 Glue 테이블 생성 수정:
  - 파티션 키: `domain`, `year`, `month`, `day` (level 제거)
  - Partition Projection:
    - domain: enum (config.domains의 name 목록)
    - year: integer 2024-2030
    - month: integer 1-12 digits=2
    - day: integer 1-31 digits=2
  - `storage.location.template`: `s3://{bucket}/{base_prefix}${domain}/${year}/${month}/${day}/`
  - SerDe: JSON SerDe 유지
  - 일반 컬럼: timestamp, level, service, message, trace_id (domain은 파티션)
- [ ] `scripts/fix-glue-table.ts` 업데이트 (새 구조 반영)
- [ ] `npx tsc --noEmit` 통과

## qa
- [ ] Glue 테이블이 새 파티션 구조로 생성됨
- [ ] Athena에서 `SHOW PARTITIONS`로 프로젝션 확인

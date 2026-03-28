# Task: athena-query 수정 — 도메인별 경로 쿼리 지원

> **Spec:** docs/s3-logwatch-tech-decisions.md#4
> **Priority:** 🟠 P1 — 쿼리가 새 S3 경로를 인식해야 함
> **Status:** done
> **Depends on:** T-009, T-011

## Context
Glue 테이블의 partition projection이 `s3://{bucket}/{base_prefix}${domain}/${year}/${month}/${day}/`로
설정되어 있으므로, Athena SQL에서 `WHERE domain='user'` 조건을 사용하면
자동으로 해당 S3 경로만 스캔한다.

athena-query 도구 자체는 SQL을 그대로 전달하므로 큰 수정은 필요 없지만,
도구 설명(description)을 업데이트하여 Claude가 domain 조건을 포함한 SQL을 생성하도록 유도해야 한다.

## be
- [ ] `src/tools/query.ts` 수정:
  - 도구 설명에 도메인 목록과 파티션 구조 안내 추가
  - 예: "Available domains: user, order, payment, auth, notification. Use WHERE domain='...' for partition filtering."
  - 도구 설명에 테이블 스키마 정보 포함 (Claude가 SQL 생성 시 참조)
- [ ] config에서 domains 목록을 읽어 동적으로 도구 설명 생성

## qa
- [ ] domain 조건 포함 쿼리가 해당 S3 경로만 스캔하는지 확인
- [ ] domain 조건 없는 쿼리도 전체 스캔으로 동작하는지 확인

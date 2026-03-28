# Task: Firehose + IAM 역할 생성 — 실제 파이프라인 완성

> **Spec:** docs/s3-logwatch-tech-decisions.md#2, #8
> **Priority:** 🔴 P0 — 로그 수집 파이프라인 핵심
> **Status:** done
> **Depends on:** T-009

## Context
init-infra 도구의 Firehose/IAM 생성 로직이 코드에는 있지만 실행 스크립트(run-init-infra.ts)에서 빠져있었다.
도메인별 동적 파티셔닝을 적용하여 Firehose가 domain 필드 기반으로 S3 경로를 분기해야 한다.

## be
- [ ] `src/tools/init.ts`의 Firehose 생성 로직 수정:
  - Prefix 변경: `{base_prefix}!{partitionKeyFromQuery:domain}/!{timestamp:yyyy}/!{timestamp:MM}/!{timestamp:dd}/`
  - JQ MetadataExtraction에서 domain 필드 추출
  - DataFormatConversion은 비활성화 (JSON 유지, Parquet은 추후)
- [ ] IAM 역할 생성이 정상 동작하는지 확인
- [ ] `scripts/run-init-infra.ts` 수정: Firehose + IAM 생성 포함
- [ ] Firehose 생성 후 상태 확인 (ACTIVE 될 때까지 폴링)

## qa
- [ ] Firehose delivery stream이 ACTIVE 상태로 생성됨
- [ ] IAM 역할이 올바른 Trust Policy + Inline Policy로 생성됨
- [ ] 멱등성: 두 번 실행해도 에러 없음

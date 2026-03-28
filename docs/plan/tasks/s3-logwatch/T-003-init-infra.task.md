# Task: init-infra 도구 구현

> **Spec:** docs/s3-logwatch-tech-decisions.md#5, #8
> **Priority:** 🟠 P1 — 인프라가 있어야 로그 수집/쿼리 가능
> **Status:** done
> **Depends on:** T-001, T-002

## Context
`init-infra`는 S3, Firehose, Glue, Athena, IAM 리소스를 한 번에 생성하는 도구.
사용자가 "인프라 초기화해줘"라고 말하면 Claude Code가 이 도구를 호출한다.
AWS SDK v3로 직접 리소스를 생성한다 (CDK 아님, 런타임 실행).

## be
- [ ] `src/tools/init.ts` — `init-infra` MCP 도구 구현
- [ ] S3 버킷 생성 (config.yaml의 bucket 이름 사용)
- [ ] Glue 데이터베이스 + 테이블 생성
  - 스키마: timestamp, level, domain, service, message, trace_id
  - 파티션 키: level, domain, year, month, day
  - 입력 포맷: Parquet
- [ ] Kinesis Data Firehose delivery stream 생성
  - Parquet 변환 설정 (Glue 테이블 참조)
  - S3 출력 (Hive Partitioning prefix)
  - 버퍼 설정 (interval, size from config)
- [ ] Athena 워크그룹 생성
- [ ] IAM 역할 생성 (Firehose → S3, Firehose → Glue)
- [ ] 멱등성 보장: 이미 존재하는 리소스는 스킵
- [ ] 생성 결과 요약 반환 (생성됨/이미존재/실패)

## qa
- [ ] init-infra 실행 → 모든 리소스 생성 확인
- [ ] 두 번째 실행 시 에러 없이 스킵 (멱등성)
- [ ] config.yaml 값이 AWS 리소스에 반영되는지 확인

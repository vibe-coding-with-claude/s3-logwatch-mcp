# Task: Firehose + IAM 실제 배포

> **Priority:** 🔴 P0 — 로그 자동 수집 파이프라인 핵심
> **Status:** done
> **Depends on:** T-010

## Context
코드에는 Firehose/IAM 생성 로직이 있지만 실제 AWS에 배포되지 않았다.
run-init-infra.ts 스크립트를 실행하여 실제 리소스를 생성해야 한다.

## infra
- [ ] run-init-infra.ts 실행 → IAM 역할 생성
- [ ] run-init-infra.ts 실행 → Firehose delivery stream 생성
- [ ] Firehose가 ACTIVE 상태인지 확인
- [ ] Firehose의 S3 prefix가 도메인별 동적 파티셔닝인지 확인
- [ ] Glue 테이블이 최신 구조(domain/year/month/day)인지 확인

## qa
- [ ] aws firehose describe-delivery-stream → ACTIVE
- [ ] aws iam get-role → 존재
- [ ] Athena 쿼리 정상 동작

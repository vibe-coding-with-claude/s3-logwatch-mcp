# Task: E2E 검증 — 도메인별 경로 + Firehose 파이프라인

> **Spec:** docs/s3-logwatch-tech-decisions.md
> **Priority:** 🟡 P2 — 모든 구현 완료 후 검증
> **Status:** done
> **Depends on:** T-009, T-010, T-011, T-012, T-013

## Context
도메인별 S3 경로 라우팅이 실제로 동작하는지 전체 흐름을 검증한다.

## qa
- [x] 기존 mock 데이터 정리 (이전 경로 구조) -- 새 테이블은 seungjae/ prefix만 참조
- [x] `scripts/seed-mock-logs.ts` 수정: 새 경로 구조로 업로드
  - `seungjae/user/2026/03/28/`
  - `seungjae/order/2026/03/28/`
  - `seungjae/payment/2026/03/28/`
  - 등등 (5개 도메인 x 100건 = 500건)
- [x] Glue 테이블 재생성 (fix-glue-table.ts)
- [x] Athena 쿼리 테스트:
  - `SELECT domain, count(*) FROM logs GROUP BY domain` -> 5 domains x 100 = 500 OK
  - `SELECT ... WHERE domain='user' LIMIT 5` -> user 경로만 스캔 (0.01 MB)
  - `SELECT ... WHERE domain='payment' GROUP BY domain, level` -> payment 5 levels OK
  - `SELECT count(*) WHERE domain='order' AND year='2026' AND month='03'` -> 100 OK
- [x] 비용: domain 필터 시 스캔량 0.01~0.02 MB vs 전체 0.09 MB (약 80% 절감)
- [ ] Firehose 파이프라인 (가능하면): CloudWatch -> Firehose -> S3 경로 확인 (별도 수행)

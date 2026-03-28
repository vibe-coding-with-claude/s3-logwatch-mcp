# T-006 get-cost 결과

## 생성/수정된 파일

| 파일 | 변경 내용 |
|------|----------|
| `src/tools/cost.ts` | **신규** - get-cost MCP 도구 구현 |
| `src/tools/index.ts` | **수정** - registerCostTool import 및 호출 추가 |
| `docs/plan/tasks/s3-logwatch/T-006-get-cost.task.md` | **수정** - Status: draft -> done |

## 비용 계산 방식

- Athena 과금 기준: **$5/TB** (스캔한 데이터량 기준)
- query.ts에서 각 쿼리 실행 시 `DataScannedInBytes`를 기록하고, `COST_PER_BYTE = 5 / (1024^4)` 상수를 곱하여 비용을 계산합니다.
- get-cost 도구는 `queryHistory` 배열을 순회하며 `scannedBytes`와 `cost`를 합산합니다.
- 스캔량: MB 단위 (소수점 2자리)
- 비용: $ 단위 (소수점 6자리)

## 세션 기반 추적의 의미

- `queryHistory`는 모듈 레벨 변수(배열)로, MCP 서버 프로세스가 살아 있는 동안만 유지됩니다.
- **서버(프로세스)가 재시작되면 queryHistory가 초기화**되므로 비용 추적도 리셋됩니다.
- 영구 저장은 불필요합니다 -- 실제 청구 내역은 AWS Billing 콘솔에서 확인할 수 있기 때문입니다.

## 출력 예시

### 쿼리가 없는 경우

```
이번 세션에서 실행한 쿼리가 없습니다.
```

### 쿼리가 있는 경우 (3건 예시)

```
=== Athena 쿼리 비용 요약 ===

총 쿼리 수: 3건
총 스캔량:  15.75 MB
총 예상 비용: $0.000075

--- 쿼리별 내역 ---

| #  | 시간                | SQL (앞 50자)                                      | 스캔량      | 비용        |
|----|---------------------|----------------------------------------------------|-------------|-------------|
|  1 | 2026-03-28T10:30:00 | SELECT level, count(*) FROM logs WHERE year='20... |     5.25 MB |   $0.000025 |
|  2 | 2026-03-28T10:35:12 | SELECT * FROM logs WHERE level='ERROR' AND mont... |     8.00 MB |   $0.000038 |
|  3 | 2026-03-28T10:40:45 | SELECT message FROM logs LIMIT 100                 |     2.50 MB |   $0.000012 |

※ Athena 과금 기준: $5/TB (스캔한 데이터량 기준)
※ 위 비용은 예상치이며, 실제 청구 금액은 AWS 콘솔에서 확인하세요.
```

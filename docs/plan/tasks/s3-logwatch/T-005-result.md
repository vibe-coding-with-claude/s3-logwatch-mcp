# T-005 athena-query 도구 구현 결과

## 생성/수정된 파일

| 파일 | 변경 내용 |
|------|-----------|
| `src/tools/query.ts` | **신규 생성** - athena-query MCP 도구 전체 구현 |
| `src/tools/index.ts` | **수정** - registerQueryTool import 및 호출 추가 |
| `docs/plan/tasks/s3-logwatch/T-005-athena-query.task.md` | **수정** - Status를 done으로 변경 |

## Athena 쿼리 실행 흐름

```
사용자 요청 ("오늘 에러 로그 보여줘")
    |
    v
Claude가 SQL 생성
    |
    v
athena-query 도구 호출 (sql 파라미터)
    |
    v
1. config.yaml 로드 (workgroup, output_location)
    |
    v
2. StartQueryExecution
   - QueryString: 사용자가 전달한 SQL
   - WorkGroup: config의 athena.workgroup
   - Database: s3_logwatch (Glue 데이터베이스)
   - OutputLocation: config의 athena.output_location
    |
    v
3. GetQueryExecution 폴링
   - 1초 간격으로 상태 확인
   - 최대 60초 대기
   - QUEUED -> RUNNING -> SUCCEEDED/FAILED/CANCELLED
   - 매 폴링마다 stderr로 상태 로깅
    |
    v
4. 성공 시 GetQueryResults
   - ResultSet.Rows를 테이블 형식으로 변환
   - 첫 번째 Row = 헤더, 나머지 = 데이터
    |
    v
5. 비용 계산 + 응답 반환
```

## 비용 계산 방식

- AWS Athena 가격: **$5 / TB** (스캔한 데이터 기준)
- `Statistics.DataScannedInBytes` 값을 사용
- 계산 공식: `cost = scannedBytes / (1024^4) * 5`
- 결과 하단에 `Scanned: X.XX MB  Cost: $Y.YYYYYY` 형식으로 표시

## 세션 내 비용 추적 구조

- **모듈 레벨 변수** `queryHistory: QueryRecord[]`를 export
- 각 쿼리 실행마다 기록 추가:
  - `sql`: 실행한 SQL 쿼리문
  - `scannedBytes`: 스캔한 데이터 크기 (bytes)
  - `cost`: 예상 비용 (USD)
  - `timestamp`: 실행 시각 (ISO 8601)
- MCP 서버 프로세스가 살아 있는 동안 누적됨
- T-006 get-cost 도구에서 `queryHistory`를 import하여 비용 요약 제공

## 결과 포맷 예시

```
level | count
------|------
ERROR | 42
WARN  | 128
INFO  | 3504

Scanned: 12.45 MB  Cost: $0.000059
```

## 에러 처리

| 상황 | 응답 |
|------|------|
| 쿼리 실패 (SQL 오류 등) | StateChangeReason 메시지 반환, isError: true |
| 쿼리 취소 | "쿼리가 취소되었습니다." 반환, isError: true |
| 타임아웃 (60초 초과) | 타임아웃 메시지 + QueryExecutionId 반환, isError: true |
| QueryExecutionId 미반환 | AWS 설정 확인 안내 메시지, isError: true |
| 기타 예외 | error.message 반환, isError: true |

## 타입 체크

`npx tsc --noEmit` 통과 확인 완료.

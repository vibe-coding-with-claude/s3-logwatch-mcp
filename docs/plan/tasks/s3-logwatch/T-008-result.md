# T-008 결과: E2E 테스트 (로그 수집 -> 쿼리 전체 흐름)

## 사전 조건

### 1. AWS CLI 설정

```bash
aws configure
# AWS Access Key ID, Secret Access Key, Region 입력
```

### 2. 필요한 AWS 권한

E2E 테스트를 실행하는 IAM 사용자/역할에 다음 권한이 필요합니다:

| 서비스 | 필요 권한 | 용도 |
|--------|-----------|------|
| S3 | s3:CreateBucket, s3:HeadBucket, s3:ListBucket, s3:PutObject, s3:GetObject | 로그 버킷 생성/확인/조회 |
| Glue | glue:CreateDatabase, glue:GetDatabase, glue:CreateTable, glue:GetTable | 메타데이터 카탈로그 관리 |
| IAM | iam:CreateRole, iam:GetRole, iam:PutRolePolicy | 서비스 간 권한 역할 생성 |
| Firehose | firehose:CreateDeliveryStream, firehose:DescribeDeliveryStream | 스트리밍 파이프라인 생성/확인 |
| Athena | athena:CreateWorkGroup, athena:GetWorkGroup, athena:StartQueryExecution, athena:GetQueryExecution, athena:GetQueryResults | 쿼리 실행 환경 관리 |
| CloudWatch Logs | logs:PutSubscriptionFilter, logs:DescribeSubscriptionFilters | 로그 그룹 연결 관리 |

### 3. 테스트용 CloudWatch Log Group

connect-log-group 단계를 테스트하려면 CloudWatch Log Group이 존재해야 합니다:

```bash
aws logs create-log-group --log-group-name /ecs/e2e-test --region us-east-1
```

### 4. npm 의존성 설치

```bash
cd /Users/seungjae/Desktop/work/mcp-server
npm install
```

---

## 실행 방법

### 기본 실행

```bash
cd /Users/seungjae/Desktop/work/mcp-server
npm run e2e
```

### 환경 변수로 설정 변경

```bash
# 서울 리전에서 실행
E2E_REGION=ap-northeast-2 npm run e2e

# 테스트할 Log Group 변경
E2E_LOG_GROUP=/ecs/my-service npm run e2e

# init-infra 단계 건너뛰기 (이미 실행한 경우)
E2E_SKIP_INIT=true npm run e2e

# connect-log-group 단계 건너뛰기
E2E_SKIP_CONNECT=true npm run e2e

# 여러 환경 변수 조합
E2E_REGION=ap-northeast-2 E2E_SKIP_INIT=true E2E_SKIP_CONNECT=true npm run e2e
```

---

## 각 테스트 단계 설명

### 단계 1: config.yaml 기본값 생성 확인

- `~/.s3-logwatch/config.yaml` 파일이 자동 생성되는지 확인합니다.
- 필수 필드(s3.bucket, firehose.delivery_stream, athena.workgroup 등)가 존재하는지 검증합니다.
- AWS 호출 없이 로컬에서만 실행됩니다.

### 단계 2: init-infra AWS 리소스 확인

- init-infra 도구가 생성한 AWS 리소스가 실제로 존재하는지 확인합니다.
- 확인 대상: S3 버킷, Glue 데이터베이스, Glue 테이블, Firehose 스트림, Athena 워크그룹
- 이 단계는 init-infra가 이미 실행된 상태를 전제로 합니다.
- 처음이라면 먼저 Claude Code에서 "s3-logwatch 인프라 초기화해줘"를 실행하세요.

### 단계 3: connect-log-group Subscription Filter 확인

- 테스트 Log Group에 s3-logwatch Subscription Filter가 존재하는지 확인합니다.
- config.yaml의 connections 목록에 기록되어 있는지 확인합니다.
- 이 단계는 connect-log-group이 이미 실행된 상태를 전제로 합니다.
- 처음이라면 먼저 Claude Code에서 "e2e-test 로그 그룹 연결해줘"를 실행하세요.

### 단계 4: S3 로그 데이터 적재 확인

- S3 버킷의 logs/ prefix에 파일이 존재하는지 확인합니다.
- Firehose 버퍼 시간(기본 300초, 5분) 대기 후에야 파일이 나타납니다.
- 데이터가 없어도 테스트는 실패하지 않고 안내 메시지를 출력합니다.

### 단계 5: Athena 쿼리 실행 테스트

- 간단한 테스트 쿼리 (`SELECT 1 AS test_value`)를 Athena에 제출합니다.
- 쿼리가 SUCCEEDED 상태로 완료되는지 확인합니다 (최대 30초 대기).
- Athena 워크그룹과 쿼리 실행 환경이 정상인지 검증합니다.
- 참고: 파티션 필터 테스트(WHERE level='ERROR')는 S3에 데이터가 적재된 후 수동으로 수행하세요.

### 단계 6: get-cost 비용 계산 검증

- 비용 계산 로직의 정확성을 검증합니다 ($5/TB 기준).
- queryHistory 배열의 동작을 확인합니다.
- 이 E2E 테스트에서는 AWS SDK를 직접 호출하므로 queryHistory에 자동 기록되지는 않습니다.

---

## 예상 소요 시간

| 단계 | 소요 시간 | 비고 |
|------|-----------|------|
| 1. config.yaml 확인 | < 1초 | 로컬 파일 I/O만 |
| 2. init-infra 확인 | 5~10초 | AWS API 호출 (5개 서비스) |
| 3. connect-log-group 확인 | 2~5초 | AWS API 호출 |
| 4. S3 데이터 확인 | 2~5초 | S3 ListObjects |
| 5. Athena 쿼리 | 5~30초 | 쿼리 제출 + 폴링 대기 |
| 6. 비용 검증 | < 1초 | 로컬 계산만 |
| **합계** | **약 15~50초** | AWS 응답 속도에 따라 다름 |

### Firehose 버퍼 대기 시간 (단계 4 관련)

- Firehose는 `buffer_interval` (기본 300초 = 5분) 또는 `buffer_size` (기본 5MB) 조건 중 하나가 충족되면 S3에 파일을 씁니다.
- 테스트 로그를 발생시킨 후 **최소 5분을 기다려야** S3에 Parquet 파일이 나타납니다.
- 급한 경우 AWS 콘솔에서 Firehose의 buffer_interval을 60초로 줄일 수 있습니다.

---

## 테스트 후 정리 방법 (리소스 삭제)

테스트 완료 후 비용 발생을 방지하려면 생성된 AWS 리소스를 삭제해야 합니다. 아래 순서대로 삭제하세요 (의존성 순서 중요):

### 1. Subscription Filter 삭제

```bash
aws logs delete-subscription-filter \
  --log-group-name /ecs/e2e-test \
  --filter-name s3-logwatch-ecs-e2e-test \
  --region us-east-1
```

### 2. Firehose 스트림 삭제

```bash
aws firehose delete-delivery-stream \
  --delivery-stream-name s3-logwatch-stream \
  --region us-east-1
```

### 3. Athena 워크그룹 삭제

```bash
aws athena delete-work-group \
  --work-group s3-logwatch \
  --recursive-delete-option \
  --region us-east-1
```

### 4. Glue 테이블 및 데이터베이스 삭제

```bash
aws glue delete-table \
  --database-name s3_logwatch \
  --name logs \
  --region us-east-1

aws glue delete-database \
  --name s3_logwatch \
  --region us-east-1
```

### 5. IAM 역할 삭제

```bash
# Firehose 역할
aws iam delete-role-policy \
  --role-name s3-logwatch-firehose-role \
  --policy-name s3-logwatch-firehose-policy

aws iam delete-role \
  --role-name s3-logwatch-firehose-role

# CloudWatch Logs -> Firehose 역할
aws iam delete-role-policy \
  --role-name s3-logwatch-cwl-to-firehose-role \
  --policy-name s3-logwatch-cwl-to-firehose-policy

aws iam delete-role \
  --role-name s3-logwatch-cwl-to-firehose-role
```

### 6. S3 버킷 삭제 (데이터 포함)

```bash
# 버킷 내 모든 객체 삭제 후 버킷 삭제
aws s3 rb s3://s3-logwatch-logs --force --region us-east-1
```

### 7. 테스트용 Log Group 삭제 (선택)

```bash
aws logs delete-log-group \
  --log-group-name /ecs/e2e-test \
  --region us-east-1
```

### 8. 로컬 설정 파일 삭제 (선택)

```bash
rm -rf ~/.s3-logwatch/
```

---

## 전체 파이프라인 흐름도

```
[사용자]
  |  "s3-logwatch 인프라 초기화해줘"
  v
[Claude Code]
  |  init-infra 도구 호출
  v
[MCP Server - init-infra]
  |  AWS 리소스 생성
  v
[AWS] S3 버킷 + Glue DB/Table + IAM Role + Firehose + Athena Workgroup
  |
  |  "payment-api 로그 그룹 연결해줘"
  v
[MCP Server - connect-log-group]
  |  Subscription Filter 생성
  v
[CloudWatch Logs]  --(Subscription Filter)--> [Firehose]
  |                                              |
  |  애플리케이션 로그 발생                       |  JSON -> Parquet 변환
  |                                              |  Hive 파티셔닝
  v                                              v
[Log Group]                                    [S3 Bucket]
                                                 |  level=ERROR/domain=payment/year=2026/...
                                                 |
  "오늘 에러 로그 보여줘"                         |
  v                                              |
[MCP Server - athena-query]                      |
  |  SQL 쿼리 실행                                |
  v                                              v
[Athena] --(스캔)----------------------------->[S3 Parquet 데이터]
  |
  |  결과 + 스캔량 + 비용
  v
[Claude Code]
  |  결과 분석 + 자연어 답변
  v
[사용자] "오늘 payment 도메인에서 ERROR가 42건 발생했습니다. (Scanned: 12MB  Cost: $0.00006)"
  |
  |  "쿼리 비용 얼마야?"
  v
[MCP Server - get-cost]
  |  세션 내 누적 비용 조회
  v
[사용자] "총 2건 쿼리, 스캔 24MB, 비용 $0.00012"
```

---

## 타입 체크 결과

모든 소스 파일에 대해 `npx tsc --noEmit` 타입 체크가 통과했습니다.

검증된 파일:
- `src/index.ts` - MCP Server 진입점
- `src/config.ts` - 설정 파일 관리
- `src/tools/index.ts` - 도구 등록 모듈
- `src/tools/config.ts` - update-config 도구
- `src/tools/init.ts` - init-infra 도구
- `src/tools/connect.ts` - connect-log-group 도구
- `src/tools/query.ts` - athena-query 도구
- `src/tools/cost.ts` - get-cost 도구

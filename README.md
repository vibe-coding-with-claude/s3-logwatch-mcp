[한국어](#s3-logwatch-mcp) | [English](#s3-logwatch-mcp-1)

---

# s3-logwatch-mcp

> Claude Code에서 자연어로 AWS 로그를 분석하는 MCP Server

```
> "오늘 payment 도메인에서 에러가 얼마나 발생했어?"

  message                                          | timestamp
  -------------------------------------------------|---------------------------
  2026-03-28 14:23:45 ERROR --- Connection timeout | 2026-03-28T14:23:45.000Z
  2026-03-28 14:25:12 ERROR --- Read timeout 30s   | 2026-03-28T14:25:12.000Z

  Scanned: 0.01 MB  Cost: $0.000000 (fresh)
```

**앱 로그 포맷 제약 없음** — Spring Boot 텍스트, Node.js JSON, 아무 형식이나 그대로 수집.

## MCP 도구 목록

| 도구 | 설명 | 자연어 예시 |
|---|---|---|
| `init-infra` | AWS 리소스 일괄 생성 (S3, Athena, Lambda, Firehose, IAM) | "인프라 초기화해줘" |
| `connect-log-group` | CloudWatch Log Group → Firehose 연결 | "payment-api 연결해줘, 도메인은 payment" |
| `disconnect-log-group` | Log Group 연결 해제 | "payment-api 연결 해제해줘" |
| `destroy-infra` | AWS 리소스 전체 삭제 | "인프라 삭제해줘" |
| `athena-query` | Athena SQL 실행 + 결과 + 비용 (5분 캐싱) | "payment 에러 보여줘" |
| `get-cost` | 세션 내 누적 쿼리 비용 | "쿼리 비용 얼마야?" |
| `update-config` | 설정 조회/수정 (도메인 추가 시 Athena 자동 갱신) | "billing 도메인 추가해줘" |
| `set-alert` | 알림 규칙 추가/삭제/조회 | "ERROR 50건 넘으면 Slack 알림" |
| `check-alerts` | 알림 규칙 체크 + threshold 초과 감지 | "알림 확인해줘" |

## 빠른 시작

### 사전 조건

- [Claude Code](https://claude.ai/code) 설치
- Node.js 20+
- AWS CLI 설정 완료 (`aws configure`)
- 필요 AWS 권한: S3, IAM, Firehose, Lambda, Athena, CloudWatch Logs
- 기본 리전: ap-northeast-2 (서울) — `~/.s3-logwatch/config.yaml`에서 변경 가능

### 설치

```bash
git clone https://github.com/vibe-coding-with-claude/s3-logwatch-mcp.git
cd s3-logwatch-mcp
cd mcp-server && npm install
```

### 사용법

```bash
cd s3-logwatch-mcp
claude
```

#### Step 1: 인프라 초기화 (최초 1회)

```
> "s3-logwatch 인프라 초기화해줘"
```

S3, Athena DB/테이블, Lambda, Firehose, IAM 역할이 자동 생성됩니다.

#### Step 2: 로그 그룹 연결

```
> "payment-api 로그 그룹 연결해줘, 도메인은 payment"
> "/ecs/auth-service 로그 그룹 연결해줘, 도메인은 auth, ERROR만 필터링"
```

**앱 로그를 수정할 필요 없습니다.** Lambda가 CloudWatch 메타데이터에서 domain을 자동 매핑합니다.

#### Step 3: 로그 분석

```
> "payment 도메인에서 에러 몇 건이야?"
> "user 도메인 최근 3일 에러 Top 5"
> "order 도메인 3월 28일 로그 전부 보여줘"
```

동일 쿼리는 5분간 캐싱됩니다 (비용 $0).

#### Step 4: 비용 확인

```
> "쿼리 비용 얼마야?"
```

#### Step 5: 알림 설정

```
> "payment 도메인에서 10분간 ERROR 50건 넘으면 알려줘"
> "알림 규칙 확인해줘"
```

#### Step 6: 정리

```
> "auth 로그 그룹 연결 해제해줘"
> "인프라 전부 삭제해줘"
```

## 설정

`~/.s3-logwatch/config.yaml`:

```yaml
region: ap-northeast-2              # AWS 리전 (변경 가능)

s3:
  bucket: s3-logwatch-logs-ap2      # S3 버킷 이름
  base_prefix: seungjae/            # S3 루트 경로
  retention_days: 90                # 로그 보존 일수

firehose:
  delivery_stream: s3-logwatch-stream
  buffer_interval: 300              # 초
  buffer_size: 5                    # MB
  format: json                      # json | parquet

athena:
  workgroup: s3-logwatch            # Athena 워크그룹 이름
  output_location: s3://s3-logwatch-logs-ap2/athena-results/
  database: s3_logwatch             # Athena 데이터베이스 이름
  table: logs                       # Athena 테이블 이름

# IAM/Lambda 리소스 이름 (모두 변경 가능)
resource_names:
  firehose_role: s3-logwatch-firehose-role
  lambda_role: s3-logwatch-lambda-role
  lambda_function: s3-logwatch-transformer
  cwl_to_firehose_role: s3-logwatch-cwl-to-firehose-role

domains:
  - name: user
    s3_prefix: seungjae/user/
  - name: order
    s3_prefix: seungjae/order/
  - name: payment
    s3_prefix: seungjae/payment/

alerts:
  webhook_url: https://hooks.slack.com/services/...
  rules: []
```

모든 리소스 이름을 자유롭게 변경할 수 있습니다. 하드코딩 없음.

## 왜 S3 + Athena인가?

| 기존 방식 | s3-logwatch |
|---|---|
| CloudWatch Logs Insights: **$0.005/GB 스캔** | Athena: **$5/TB 스캔** (1,000배 저렴) |
| 30일 보존 후 삭제 또는 비싼 장기 보관 | S3: **$0.023/GB/월** 무제한 보관 |
| 별도 대시보드 필요 | **터미널에서 자연어로 바로 분석** |
| 서비스마다 로그 포맷 파편화 | 도메인별 경로 파티셔닝으로 **통합 쿼리** |
| 사용 안 해도 기본 비용 발생 | **사용 안 하면 $0** |

### 월 비용 (하루 1GB 로그, 무료 티어 제외)

| 항목 | 비용 |
|---|---|
| S3 저장 + 요청 | ~$0.72 |
| Firehose (동적 파티셔닝 포함) | ~$3.87 |
| Lambda | ~$0.002 |
| Athena (하루 10회 쿼리) | ~$0.15 |
| **합계** | **~$4.7/월** |

## 아키텍처

```
사용자 (터미널)
  │  자연어로 질문
  v
Claude Code
  │  MCP 도구 자동 선택 + 호출
  v
s3-logwatch MCP Server (TypeScript)
  │
  v
┌──────────────────────────────────────────────────┐
│  CloudWatch Logs (/ecs/payment-api)              │
│    → Subscription Filter                         │
│      → Kinesis Data Firehose                     │
│        → Lambda (Python) ← gzip 해제 + domain 매핑│
│          → S3 (도메인별 경로 파티셔닝)              │
│            → Athena (Partition Projection)        │
└──────────────────────────────────────────────────┘

S3 경로:
  seungjae/payment/2026/03/28/
  seungjae/user/2026/03/29/
  seungjae/order/2026/03/28/
```

## Athena DDL & Partition Projection

`init-infra` 실행 시 Athena DDL로 테이블이 자동 생성됩니다.

```sql
CREATE EXTERNAL TABLE IF NOT EXISTS s3_logwatch.logs (
  timestamp string, level string, service string,
  message string, trace_id string
)
PARTITIONED BY (domain string, year string, month string, day string)
ROW FORMAT SERDE 'org.openx.data.jsonserde.JsonSerDe'
LOCATION 's3://s3-logwatch-logs-ap2/seungjae/'
TBLPROPERTIES (
  'projection.enabled'        = 'true',
  'projection.domain.type'    = 'enum',
  'projection.domain.values'  = 'user,order,payment,auth,notification',
  'projection.year.type'      = 'integer',
  'projection.year.range'     = '2024,2030',
  'projection.month.type'     = 'integer',
  'projection.month.range'    = '1,12',
  'projection.month.digits'   = '2',
  'projection.day.type'       = 'integer',
  'projection.day.range'      = '1,31',
  'projection.day.digits'     = '2',
  'storage.location.template' = 's3://bucket/seungjae/${domain}/${year}/${month}/${day}/'
)
```

**Partition Projection**: S3에 새 폴더가 생기면 Athena가 즉시 인식. `MSCK REPAIR TABLE` 불필요.

```
쿼리: WHERE domain='payment' AND year='2026' AND month='03'
  → s3://bucket/seungjae/payment/2026/03/ 만 스캔 → 비용 최소화
```

## Lambda 변환 프로세서

CloudWatch가 Firehose로 보내는 데이터는 gzip 압축되어 있어 Lambda가 중간에서 변환합니다.

```
CloudWatch (gzip) → Firehose → Lambda (Python 3.12) → S3
                                  │
                                  ├─ gzip 해제
                                  ├─ logEvents 배열 → 개별 레코드 분리
                                  └─ logGroup → domain 매핑
```

**앱 로그 포맷 제약 없음** — Lambda는 원본 메시지를 `message` 필드에 그대로 보존합니다.

## 프로젝트 구조

```
mcp-server/
├── src/
│   ├── index.ts              # MCP Server 진입점
│   ├── config.ts             # config.yaml 관리 + 타입 정의
│   ├── lambda/
│   │   └── transformer.py    # Firehose Lambda (Python 3.12)
│   ├── tools/
│   │   ├── index.ts          # 도구 등록 허브
│   │   ├── init.ts           # init-infra
│   │   ├── destroy.ts        # destroy-infra
│   │   ├── connect.ts        # connect-log-group
│   │   ├── disconnect.ts     # disconnect-log-group
│   │   ├── query.ts          # athena-query (캐싱 포함)
│   │   ├── cost.ts           # get-cost
│   │   ├── config.ts         # update-config
│   │   ├── alert.ts          # set-alert
│   │   └── check-alert.ts    # check-alerts
│   └── __tests__/            # 단위 테스트 (Vitest)
├── scripts/                  # E2E 테스트, mock 데이터
├── .github/workflows/ci.yml  # CI 파이프라인
├── package.json
└── tsconfig.json
```

## 기술 스택

| 영역 | 기술 | 선택 이유 |
|---|---|---|
| 언어 | TypeScript | MCP 공식 SDK가 가장 성숙 |
| Lambda | Python 3.12 | 표준 라이브러리만으로 gzip/json 처리, 외부 의존성 0 |
| MCP SDK | @modelcontextprotocol/sdk | 공식 TypeScript SDK |
| AWS SDK | AWS SDK for JS v3 | TypeScript 네이티브, 모듈별 분리 |
| 수집 | CloudWatch + Firehose + Lambda | 앱 로그 무수정, 자동 domain 매핑 |
| 저장 | S3 (도메인별 경로) | 비용 최저, 무한 확장 |
| 카탈로그 | Athena DDL + Partition Projection | Glue SDK 불필요, 파티션 자동 인식 |
| 쿼리 | Amazon Athena | S3 직접 쿼리, 스캔량 기반 과금 |
| 테스트 | Vitest | 31개 단위 테스트 |
| CI | GitHub Actions | push/PR 시 자동 tsc + test |

## 라이선스

MIT

---

# s3-logwatch-mcp

> MCP Server for analyzing AWS logs with natural language through Claude Code

```
> "How many errors occurred in the payment domain today?"

  message                                          | timestamp
  -------------------------------------------------|---------------------------
  2026-03-28 14:23:45 ERROR --- Connection timeout | 2026-03-28T14:23:45.000Z
  2026-03-28 14:25:12 ERROR --- Read timeout 30s   | 2026-03-28T14:25:12.000Z

  Scanned: 0.01 MB  Cost: $0.000000 (fresh)
```

**No log format restrictions** — Spring Boot text, Node.js JSON, any format works as-is.

## MCP Tools

| Tool | Description | Example |
|---|---|---|
| `init-infra` | Create all AWS resources (S3, Athena, Lambda, Firehose, IAM) | "Initialize infrastructure" |
| `connect-log-group` | Connect CloudWatch Log Group → Firehose | "Connect payment-api, domain is payment" |
| `disconnect-log-group` | Disconnect Log Group | "Disconnect payment-api" |
| `destroy-infra` | Delete all AWS resources | "Destroy infrastructure" |
| `athena-query` | Execute Athena SQL + results + cost (5min cache) | "Show payment errors" |
| `get-cost` | View cumulative query costs | "How much did queries cost?" |
| `update-config` | View/modify config (auto-updates Athena on domain change) | "Add billing domain" |
| `set-alert` | Add/remove/list alert rules | "Alert on ERROR > 50" |
| `check-alerts` | Check alert rules + threshold detection | "Check alerts" |

## Quick Start

### Prerequisites

- [Claude Code](https://claude.ai/code) installed
- Node.js 20+
- AWS CLI configured (`aws configure`)
- Required permissions: S3, IAM, Firehose, Lambda, Athena, CloudWatch Logs
- Default region: ap-northeast-2 (Seoul) — configurable in `~/.s3-logwatch/config.yaml`

### Installation

```bash
git clone https://github.com/vibe-coding-with-claude/s3-logwatch-mcp.git
cd s3-logwatch-mcp
cd mcp-server && npm install
```

### Usage

```bash
cd s3-logwatch-mcp
claude
```

#### Step 1: Initialize Infrastructure (one-time)

```
> "Initialize s3-logwatch infrastructure"
```

Creates S3, Athena DB/table, Lambda, Firehose, and IAM roles.

#### Step 2: Connect Log Groups

```
> "Connect payment-api log group, domain is payment"
> "Connect /ecs/auth-service, domain is auth, filter ERROR only"
```

**No app log changes needed.** Lambda auto-maps domain from CloudWatch metadata.

#### Step 3: Analyze Logs

```
> "How many errors in payment domain?"
> "Top 5 errors in user domain over last 3 days"
> "Show all order domain logs from March 28"
```

Same queries are cached for 5 minutes (cost $0).

#### Step 4: Check Costs

```
> "How much did queries cost?"
```

#### Step 5: Set Alerts

```
> "Alert me if payment ERROR exceeds 50 in 10 minutes"
> "Check alert rules"
```

#### Step 6: Cleanup

```
> "Disconnect auth log group"
> "Destroy all infrastructure"
```

## Configuration

`~/.s3-logwatch/config.yaml`:

```yaml
region: ap-northeast-2              # AWS region (configurable)

s3:
  bucket: s3-logwatch-logs-ap2
  base_prefix: seungjae/
  retention_days: 90

firehose:
  delivery_stream: s3-logwatch-stream
  buffer_interval: 300
  buffer_size: 5
  format: json                      # json | parquet

athena:
  workgroup: s3-logwatch
  output_location: s3://s3-logwatch-logs-ap2/athena-results/
  database: s3_logwatch             # Athena database name
  table: logs                       # Athena table name

# IAM/Lambda resource names (all configurable)
resource_names:
  firehose_role: s3-logwatch-firehose-role
  lambda_role: s3-logwatch-lambda-role
  lambda_function: s3-logwatch-transformer
  cwl_to_firehose_role: s3-logwatch-cwl-to-firehose-role

domains:
  - name: user
    s3_prefix: seungjae/user/
  - name: order
    s3_prefix: seungjae/order/
  - name: payment
    s3_prefix: seungjae/payment/

alerts:
  webhook_url: https://hooks.slack.com/services/...
  rules: []
```

All resource names are fully configurable. Zero hardcoding.

## Why S3 + Athena?

| Traditional | s3-logwatch |
|---|---|
| CloudWatch Logs Insights: **$0.005/GB scanned** | Athena: **$5/TB scanned** (1,000x cheaper) |
| 30-day retention or expensive long-term storage | S3: **$0.023/GB/month** unlimited retention |
| Separate dashboards needed | **Analyze from terminal with natural language** |
| Log format fragmentation | **Unified queries** via domain-based partitioning |
| Base cost even when idle | **$0 when not in use** |

### Monthly Cost (1GB logs/day, no free tier)

| Item | Cost |
|---|---|
| S3 storage + requests | ~$0.72 |
| Firehose (with dynamic partitioning) | ~$3.87 |
| Lambda | ~$0.002 |
| Athena (10 queries/day) | ~$0.15 |
| **Total** | **~$4.7/month** |

## Architecture

```
User (Terminal)
  │  Ask in natural language
  v
Claude Code
  │  Auto-selects + calls MCP tools
  v
s3-logwatch MCP Server (TypeScript)
  │
  v
┌──────────────────────────────────────────────────┐
│  CloudWatch Logs (/ecs/payment-api)              │
│    → Subscription Filter                         │
│      → Kinesis Data Firehose                     │
│        → Lambda (Python) ← gzip decode + domain  │
│          → S3 (domain-based path partitioning)   │
│            → Athena (Partition Projection)        │
└──────────────────────────────────────────────────┘

S3 paths:
  seungjae/payment/2026/03/28/
  seungjae/user/2026/03/29/
  seungjae/order/2026/03/28/
```

## Athena DDL & Partition Projection

```sql
CREATE EXTERNAL TABLE IF NOT EXISTS s3_logwatch.logs (
  timestamp string, level string, service string,
  message string, trace_id string
)
PARTITIONED BY (domain string, year string, month string, day string)
ROW FORMAT SERDE 'org.openx.data.jsonserde.JsonSerDe'
LOCATION 's3://s3-logwatch-logs-ap2/seungjae/'
TBLPROPERTIES (
  'projection.enabled'        = 'true',
  'projection.domain.type'    = 'enum',
  'projection.domain.values'  = 'user,order,payment,auth,notification',
  'projection.year.type'      = 'integer',
  'projection.year.range'     = '2024,2030',
  'projection.month.type'     = 'integer',
  'projection.month.range'    = '1,12',
  'projection.month.digits'   = '2',
  'projection.day.type'       = 'integer',
  'projection.day.range'      = '1,31',
  'projection.day.digits'     = '2',
  'storage.location.template' = 's3://bucket/seungjae/${domain}/${year}/${month}/${day}/'
)
```

**Partition Projection**: New S3 folders are instantly recognized. No `MSCK REPAIR TABLE`.

## Lambda Transformer

```
CloudWatch (gzip) → Firehose → Lambda (Python 3.12) → S3
                                  │
                                  ├─ gzip decompress
                                  ├─ logEvents array → individual records
                                  └─ logGroup → domain mapping
```

**No log format restrictions** — Lambda preserves the original message in the `message` field.

## Project Structure

```
mcp-server/
├── src/
│   ├── index.ts              # MCP Server entry point
│   ├── config.ts             # config.yaml management + types
│   ├── lambda/
│   │   └── transformer.py    # Firehose Lambda (Python 3.12)
│   ├── tools/
│   │   ├── index.ts          # Tool registration hub
│   │   ├── init.ts           # init-infra
│   │   ├── destroy.ts        # destroy-infra
│   │   ├── connect.ts        # connect-log-group
│   │   ├── disconnect.ts     # disconnect-log-group
│   │   ├── query.ts          # athena-query (with caching)
│   │   ├── cost.ts           # get-cost
│   │   ├── config.ts         # update-config
│   │   ├── alert.ts          # set-alert
│   │   └── check-alert.ts    # check-alerts
│   └── __tests__/            # Unit tests (Vitest)
├── scripts/                  # E2E tests, mock data
├── .github/workflows/ci.yml  # CI pipeline
├── package.json
└── tsconfig.json
```

## Tech Stack

| Area | Technology | Why |
|---|---|---|
| Language | TypeScript | Most mature MCP SDK |
| Lambda | Python 3.12 | stdlib-only gzip/json, zero dependencies |
| MCP SDK | @modelcontextprotocol/sdk | Official TypeScript SDK |
| AWS SDK | AWS SDK for JS v3 | Native TS, modular |
| Ingestion | CloudWatch + Firehose + Lambda | No app changes, auto domain mapping |
| Storage | S3 (domain-based paths) | Lowest cost, infinite scale |
| Catalog | Athena DDL + Partition Projection | No Glue SDK, auto partition discovery |
| Query | Amazon Athena | Direct S3 query, pay-per-scan |
| Test | Vitest | 31 unit tests |
| CI | GitHub Actions | Auto tsc + test on push/PR |

## License

MIT

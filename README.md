[한국어](#s3-logwatch-mcp) | [English](#s3-logwatch-mcp-1)

---

# s3-logwatch-mcp

> Claude Code에서 자연어로 AWS 로그를 분석하는 MCP Server

```
> "오늘 payment 도메인에서 에러가 얼마나 발생했어?"

  level   | domain  | count
  --------|---------|------
  ERROR   | payment | 52

  Scanned: 0.01 MB  Cost: $0.000000
```

## 왜 S3 + Athena인가?

| 기존 방식 | s3-logwatch |
|---|---|
| CloudWatch Logs Insights: **$0.005/GB 스캔** | Athena: **$5/TB 스캔** (1,000배 저렴) |
| 30일 보존 후 삭제 또는 비싼 장기 보관 | S3: **$0.023/GB/월** 무제한 보관 |
| 별도 대시보드 (Grafana, Datadog) 필요 | **터미널에서 자연어로 바로 분석** |
| 서비스마다 로그 포맷 파편화 | Hive Partitioning으로 **통합 쿼리** |
| 사용 안 해도 기본 비용 발생 | **사용 안 하면 $0** |

### 월 비용 비교 (하루 1GB 로그 기준)

| 항목 | s3-logwatch | CloudWatch Logs Insights |
|---|---|---|
| 저장 | ~$0.69 (S3) | ~$1.52 (CW Logs) |
| 쿼리 | ~$0.15 (Athena, 하루 10회) | ~$1.50 (Insights) |
| 수집 | ~$1.41 (Firehose) | 포함 |
| **합계** | **~$2/월** | **~$3+/월** |

> Athena는 Parquet + 파티셔닝으로 스캔량을 1/10~1/100로 줄일 수 있어 실제 비용은 더 낮습니다.

## 아키텍처

```
사용자 (터미널)
  │  자연어로 질문
  v
Claude Code
  │  MCP 도구 자동 선택 + 호출
  v
s3-logwatch MCP Server (TypeScript)
  │  AWS SDK v3로 리소스 제어
  v
┌─────────────────────────────────────────┐
│  CloudWatch Logs                        │
│    → Subscription Filter                │
│      → Kinesis Data Firehose            │
│        → S3 (Hive Partitioning)         │
│          → Athena (SQL 쿼리)            │
└─────────────────────────────────────────┘
```

## 빠른 시작

### 사전 조건

- [Claude Code](https://claude.ai/code) 설치
- Node.js 20+
- AWS CLI 설정 완료 (`aws configure`)
- 필요 AWS 권한: S3, Glue, IAM, Firehose, Athena, CloudWatch Logs

### 설치

```bash
git clone https://github.com/vibe-coding-with-claude/s3-logwatch-mcp.git
cd s3-logwatch-mcp
cd mcp-server && npm install
```

### Claude Code에 등록

프로젝트 루트의 `.mcp.json`이 자동으로 MCP Server를 등록합니다.
Claude Code를 프로젝트 디렉토리에서 실행하면 바로 사용 가능합니다.

```json
{
  "mcpServers": {
    "s3-logwatch": {
      "command": "npx",
      "args": ["tsx", "mcp-server/src/index.ts"]
    }
  }
}
```

### 사용법

프로젝트 디렉토리에서 Claude Code를 실행하세요:

```bash
cd s3-logwatch-mcp
claude
```

#### Step 1: 인프라 초기화 (최초 1회)

```
> "s3-logwatch 인프라 초기화해줘"
```

S3 버킷, Athena 데이터베이스/테이블, Firehose, IAM 역할이 자동 생성됩니다.
이미 존재하는 리소스는 스킵됩니다 (멱등성 보장).

#### Step 2: 로그 그룹 연결 (도메인 지정 필수)

```
> "payment-api 로그 그룹 연결해줘, 도메인은 payment"
> "/ecs/auth-service 로그 그룹 연결해줘, 도메인은 auth, ERROR만 필터링"
> "/ecs/user-api 로그 그룹도 연결해줘, 도메인은 user"
```

각 로그 그룹이 어떤 도메인에 속하는지 반드시 지정해야 합니다.
Firehose가 domain 필드를 기반으로 S3 경로를 자동 분기합니다:

```
s3://bucket/seungjae/payment/2026/03/28/
s3://bucket/seungjae/auth/2026/03/28/
s3://bucket/seungjae/user/2026/03/28/
```

#### Step 3: 로그 분석

```
> "오늘 payment 도메인에서 에러 몇 건이야?"
> "user 도메인의 최근 3일 에러 Top 5 보여줘"
> "order 도메인에서 timeout 에러가 언제부터 늘었어?"
> "auth 도메인 3월 28일 로그 전부 보여줘"
> "전체 도메인의 레벨별 로그 건수 집계해줘"
```

Claude가 자연어를 Athena SQL로 변환하여 실행합니다.
도메인 조건(`WHERE domain='...'`)을 포함하면 해당 S3 경로만 스캔하여 비용이 절감됩니다.

#### Step 4: 비용 확인

```
> "지금까지 쿼리 비용 얼마야?"
```

세션 내 모든 쿼리의 스캔량과 비용을 누적 조회합니다.

#### Step 5: 설정 변경

```
> "현재 설정 보여줘"
> "도메인에 billing 추가해줘, 경로는 seungjae/billing/"
> "S3 버킷 이름 변경해줘"
```

## MCP 도구 목록

| 도구 | 설명 | 자연어 예시 |
|---|---|---|
| `init-infra` | AWS 리소스 일괄 생성 (S3, Athena, Firehose, IAM) | "인프라 초기화해줘" |
| `connect-log-group` | CloudWatch Log Group → Firehose 연결 | "payment-api 로그 그룹 연결해줘, 도메인은 payment" |
| `athena-query` | Athena SQL 실행 + 결과 + 비용 표시 | "payment 도메인 에러 보여줘" |
| `get-cost` | 세션 내 누적 쿼리 비용 조회 | "쿼리 비용 얼마야?" |
| `update-config` | 설정 파일 조회/수정 | "현재 설정 보여줘" |

## 설정

`~/.s3-logwatch/config.yaml`에서 세부 설정을 조정할 수 있습니다:

```yaml
s3:
  bucket: s3-logwatch-logs
  base_prefix: seungjae/          # S3 루트 경로

firehose:
  delivery_stream: s3-logwatch-stream
  buffer_interval: 300            # 초 (5분)
  buffer_size: 5                  # MB

athena:
  workgroup: s3-logwatch
  output_location: s3://s3-logwatch-logs/athena-results/

# 도메인별 S3 경로 — 각 도메인의 로그가 분리 저장됩니다
domains:
  - name: user
    s3_prefix: seungjae/user/
  - name: order
    s3_prefix: seungjae/order/
  - name: payment
    s3_prefix: seungjae/payment/
  - name: auth
    s3_prefix: seungjae/auth/
  - name: notification
    s3_prefix: seungjae/notification/
```

### 도메인 추가 방법

1. config.yaml의 `domains`에 항목 추가
2. Athena 테이블의 partition projection이 자동 반영됨
3. 새 도메인으로 로그 그룹 연결 가능

```yaml
# 예: billing 도메인 추가
domains:
  - name: billing
    s3_prefix: seungjae/billing/
```

## 프로젝트 구조

```
mcp-server/
├── src/
│   ├── index.ts          # MCP Server 진입점 (stdio transport)
│   ├── config.ts          # config.yaml 로드/저장 + 타입 정의
│   └── tools/
│       ├── index.ts       # 도구 등록 허브
│       ├── init.ts        # init-infra: AWS 리소스 생성
│       ├── connect.ts     # connect-log-group: CW → Firehose 연결
│       ├── query.ts       # athena-query: SQL 실행 + 비용 추적
│       ├── cost.ts        # get-cost: 누적 비용 조회
│       └── config.ts      # update-config: 설정 관리
├── scripts/
│   ├── seed-mock-logs.ts  # Mock 로그 500개 생성
│   └── test-athena-query.ts  # Athena 쿼리 검증
├── package.json
└── tsconfig.json
```

## 기술 스택

| 영역 | 기술 | 선택 이유 |
|---|---|---|
| 언어 | TypeScript | MCP 공식 SDK가 가장 성숙 |
| MCP SDK | @modelcontextprotocol/sdk | 공식 TypeScript SDK |
| AWS SDK | AWS SDK for JS v3 | TypeScript 네이티브 지원, 모듈별 분리 |
| AI | Claude Code | MCP 클라이언트 역할, 별도 AI 서비스 불필요 |
| 수집 | CloudWatch + Firehose | 기존 로그와 자연스럽게 연동 |
| 저장 | S3 (도메인별 경로 파티셔닝) | 비용 최저, 무한 확장 |
| 카탈로그 | Athena DDL + Partition Projection | Glue SDK 없이 테이블 관리, 파티션 자동 인식 |
| 쿼리 | Amazon Athena | S3 직접 쿼리, 스캔량 기반 과금 |

## 라이선스

MIT

---

# s3-logwatch-mcp

> MCP Server for analyzing AWS logs with natural language through Claude Code

```
> "How many errors occurred in the payment domain today?"

  level   | domain  | count
  --------|---------|------
  ERROR   | payment | 52

  Scanned: 0.01 MB  Cost: $0.000000
```

## Why S3 + Athena?

| Traditional | s3-logwatch |
|---|---|
| CloudWatch Logs Insights: **$0.005/GB scanned** | Athena: **$5/TB scanned** (1,000x cheaper) |
| 30-day retention or expensive long-term storage | S3: **$0.023/GB/month** unlimited retention |
| Separate dashboards (Grafana, Datadog) needed | **Analyze directly from terminal with natural language** |
| Log format fragmentation across services | **Unified queries** via Hive Partitioning |
| Base cost even when idle | **$0 when not in use** |

### Monthly Cost Comparison (1GB logs/day)

| Item | s3-logwatch | CloudWatch Logs Insights |
|---|---|---|
| Storage | ~$0.69 (S3) | ~$1.52 (CW Logs) |
| Query | ~$0.15 (Athena, 10 queries/day) | ~$1.50 (Insights) |
| Ingestion | ~$1.41 (Firehose) | Included |
| **Total** | **~$2/month** | **~$3+/month** |

> With Parquet + partitioning, Athena scan volume can be reduced by 10-100x, making actual costs even lower.

## Architecture

```
User (Terminal)
  │  Ask in natural language
  v
Claude Code
  │  Auto-selects + calls MCP tools
  v
s3-logwatch MCP Server (TypeScript)
  │  Controls resources via AWS SDK v3
  v
┌─────────────────────────────────────────┐
│  CloudWatch Logs                        │
│    → Subscription Filter                │
│      → Kinesis Data Firehose            │
│        → S3 (Hive Partitioning)         │
│          → Athena (SQL Query)           │
└─────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- [Claude Code](https://claude.ai/code) installed
- Node.js 20+
- AWS CLI configured (`aws configure`)
- Required AWS permissions: S3, Glue, IAM, Firehose, Athena, CloudWatch Logs

### Installation

```bash
git clone https://github.com/vibe-coding-with-claude/s3-logwatch-mcp.git
cd s3-logwatch-mcp
cd mcp-server && npm install
```

### Register with Claude Code

The `.mcp.json` file in the project root automatically registers the MCP Server.
Just run Claude Code from the project directory.

```json
{
  "mcpServers": {
    "s3-logwatch": {
      "command": "npx",
      "args": ["tsx", "mcp-server/src/index.ts"]
    }
  }
}
```

### Usage

Run Claude Code from the project directory:

```bash
cd s3-logwatch-mcp
claude
```

#### Step 1: Initialize Infrastructure (one-time)

```
> "Initialize s3-logwatch infrastructure"
```

Creates S3 bucket, Athena database/table, Firehose, and IAM roles.
Already-existing resources are skipped (idempotent).

#### Step 2: Connect Log Groups (domain required)

```
> "Connect payment-api log group, domain is payment"
> "Connect /ecs/auth-service log group, domain is auth, filter ERROR only"
> "Connect /ecs/user-api log group, domain is user"
```

Each log group must specify which domain it belongs to.
Firehose automatically routes logs to domain-specific S3 paths:

```
s3://bucket/seungjae/payment/2026/03/28/
s3://bucket/seungjae/auth/2026/03/28/
s3://bucket/seungjae/user/2026/03/28/
```

#### Step 3: Analyze Logs

```
> "How many errors in payment domain today?"
> "Show top 5 errors in user domain over the last 3 days"
> "When did timeout errors in order domain start increasing?"
> "Show all auth domain logs from March 28"
> "Aggregate log counts by level across all domains"
```

Claude converts natural language to Athena SQL.
Including `WHERE domain='...'` scans only that domain's S3 path, reducing costs.

#### Step 4: Check Costs

```
> "How much have queries cost so far?"
```

Shows cumulative scan volume and cost for all queries in the current session.

#### Step 5: Manage Settings

```
> "Show current config"
> "Add billing domain with path seungjae/billing/"
> "Change S3 bucket name"
```

## MCP Tools

| Tool | Description | Example |
|---|---|---|
| `init-infra` | Create all AWS resources (S3, Athena, Firehose, IAM) | "Initialize infrastructure" |
| `connect-log-group` | Connect CloudWatch Log Group → Firehose | "Connect payment-api, domain is payment" |
| `athena-query` | Execute Athena SQL + results + cost display | "Show payment domain errors" |
| `get-cost` | View cumulative query costs | "How much did queries cost?" |
| `update-config` | View/modify config file | "Show current config" |

## Configuration

Adjust settings in `~/.s3-logwatch/config.yaml`:

```yaml
s3:
  bucket: s3-logwatch-logs
  base_prefix: seungjae/          # S3 root path

firehose:
  delivery_stream: s3-logwatch-stream
  buffer_interval: 300            # seconds (5 min)
  buffer_size: 5                  # MB

athena:
  workgroup: s3-logwatch
  output_location: s3://s3-logwatch-logs/athena-results/

# Domain-specific S3 paths — logs are stored separately per domain
domains:
  - name: user
    s3_prefix: seungjae/user/
  - name: order
    s3_prefix: seungjae/order/
  - name: payment
    s3_prefix: seungjae/payment/
  - name: auth
    s3_prefix: seungjae/auth/
  - name: notification
    s3_prefix: seungjae/notification/
```

### Adding a New Domain

1. Add an entry to `domains` in config.yaml
2. Athena partition projection picks it up automatically
3. Connect log groups with the new domain name

```yaml
# Example: add billing domain
domains:
  - name: billing
    s3_prefix: seungjae/billing/
```

## Project Structure

```
mcp-server/
├── src/
│   ├── index.ts          # MCP Server entry point (stdio transport)
│   ├── config.ts          # config.yaml loader + type definitions
│   └── tools/
│       ├── index.ts       # Tool registration hub
│       ├── init.ts        # init-infra: AWS resource creation
│       ├── connect.ts     # connect-log-group: CW → Firehose connection
│       ├── query.ts       # athena-query: SQL execution + cost tracking
│       ├── cost.ts        # get-cost: cumulative cost query
│       └── config.ts      # update-config: settings management
├── scripts/
│   ├── seed-mock-logs.ts  # Generate 500 mock logs
│   └── test-athena-query.ts  # Athena query verification
├── package.json
└── tsconfig.json
```

## Tech Stack

| Area | Technology | Why |
|---|---|---|
| Language | TypeScript | Most mature MCP SDK support |
| MCP SDK | @modelcontextprotocol/sdk | Official TypeScript SDK |
| AWS SDK | AWS SDK for JS v3 | Native TypeScript support, modular |
| AI | Claude Code | Acts as MCP client, no separate AI service needed |
| Ingestion | CloudWatch + Firehose | Natural integration with existing logs |
| Storage | S3 (domain-based path partitioning) | Lowest cost, infinite scale |
| Catalog | Athena DDL + Partition Projection | No Glue SDK needed, auto partition discovery |
| Query | Amazon Athena | Direct S3 query, pay-per-scan |

## License

MIT

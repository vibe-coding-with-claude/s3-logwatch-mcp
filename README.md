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

Claude Code를 열고 자연어로 대화하세요:

```bash
# 1. 인프라 초기화 (최초 1회)
> "s3-logwatch 인프라 초기화해줘"

# 2. 로그 그룹 연결
> "payment-api 로그 그룹 연결해줘"
> "/ecs/auth-service 로그 그룹도 연결해줘, ERROR만 필터링해"

# 3. 로그 분석 (자연어 → Athena SQL 자동 생성)
> "오늘 에러 로그 보여줘"
> "지난 3일간 payment 도메인에서 가장 많이 발생한 에러 Top 5"
> "auth 서비스의 timeout 에러가 언제부터 늘었어?"

# 4. 비용 확인
> "지금까지 쿼리 비용 얼마야?"
```

## MCP 도구 목록

| 도구 | 설명 | 자연어 예시 |
|---|---|---|
| `init-infra` | AWS 리소스 일괄 생성 | "인프라 초기화해줘" |
| `connect-log-group` | CloudWatch Log Group 연결 | "payment-api 로그 그룹 연결해줘" |
| `athena-query` | Athena SQL 실행 + 결과 반환 | "오늘 에러 로그 보여줘" |
| `get-cost` | 세션 내 누적 쿼리 비용 조회 | "쿼리 비용 얼마야?" |
| `update-config` | 설정 파일 조회/수정 | "S3 버킷 이름 변경해줘" |

## 설정

`~/.s3-logwatch/config.yaml`에서 세부 설정을 조정할 수 있습니다:

```yaml
s3:
  bucket: s3-logwatch-logs
  prefix: logs/
firehose:
  delivery_stream: s3-logwatch-stream
  buffer_interval: 300    # 초
  buffer_size: 5          # MB
athena:
  workgroup: s3-logwatch
  output_location: s3://s3-logwatch-logs/athena-results/
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

Open Claude Code and chat in natural language:

```bash
# 1. Initialize infrastructure (one-time)
> "Initialize s3-logwatch infrastructure"

# 2. Connect log groups
> "Connect the payment-api log group"
> "Connect /ecs/auth-service log group, filter ERROR only"

# 3. Analyze logs (natural language → auto-generated Athena SQL)
> "Show me today's error logs"
> "Top 5 most frequent errors in payment domain over the last 3 days"
> "When did timeout errors in auth service start increasing?"

# 4. Check costs
> "How much have queries cost so far?"
```

## MCP Tools

| Tool | Description | Example |
|---|---|---|
| `init-infra` | Create all AWS resources | "Initialize infrastructure" |
| `connect-log-group` | Connect CloudWatch Log Group | "Connect payment-api log group" |
| `athena-query` | Execute Athena SQL + return results | "Show today's error logs" |
| `get-cost` | View cumulative query costs | "How much did queries cost?" |
| `update-config` | View/modify config file | "Change S3 bucket name" |

## Configuration

Adjust settings in `~/.s3-logwatch/config.yaml`:

```yaml
s3:
  bucket: s3-logwatch-logs
  prefix: logs/
firehose:
  delivery_stream: s3-logwatch-stream
  buffer_interval: 300    # seconds
  buffer_size: 5          # MB
athena:
  workgroup: s3-logwatch
  output_location: s3://s3-logwatch-logs/athena-results/
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

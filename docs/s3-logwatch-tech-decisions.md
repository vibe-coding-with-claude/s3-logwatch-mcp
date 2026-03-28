# s3-logwatch -- 기술 결정 문서

> S3에 적재된 로그를 Claude Code + MCP Server를 통해 Athena로 쿼리하여 자연어로 분석하는 도구

---

## 1. 프로젝트 개요

### 목표

- 터미널에서 Claude Code를 통해 모든 것을 해결
- S3 + Athena 기반으로 "사용 안 하면 비용 $0" 달성
- 자연어 대화로 로그 분석 (Claude Code가 MCP Server 도구를 자동 호출)
- 모든 쿼리 결과에 스캔량 + 예상 비용 표시

### 사용 흐름

```
# Claude Code에서 자연어로 대화
> "s3-logwatch 인프라 초기화해줘"              -> init-infra 도구 호출
> "payment-api 로그 그룹 연결해줘"             -> connect-log-group 도구 호출
> "오늘 payment 도메인에서 에러가 얼마나 발생했어?"  -> athena-query 도구 호출
> "지금까지 쿼리 비용 얼마야?"                  -> get-cost 도구 호출
```

### Why

사이드 프로젝트로 S3 비용효율 아키텍처 + TypeScript MCP Server 경험 + 실용적 도구 포트폴리오를 동시에 쌓기 위함.

---

## 2. 로그 수집 파이프라인

### 전체 Flow

```
App (ECS, EC2, Lambda 등)
  |
  v
CloudWatch Logs (Log Group)
  |
  v
Subscription Filter (도메인/서비스별 필터 패턴)
  |
  v
Kinesis Data Firehose (Parquet 변환 내장)
  |
  v
S3 (Hive Partitioning)
```

### 상세 설명

1. **App -> CloudWatch Logs**: 애플리케이션이 CloudWatch Logs에 로그를 출력한다. Log Group 단위로 관리된다.

2. **Subscription Filter**: CloudWatch Log Group에 종속되는 필터. 도메인/서비스별 필터 패턴을 설정하여 원하는 로그만 Firehose로 전달한다. 에러 로그만이 아니라 특정 도메인/서비스의 로그를 선별적으로 수집할 수 있다.

3. **여러 Log Group -> 하나의 Firehose**: 여러 Log Group의 Subscription Filter가 하나의 Firehose delivery stream으로 모인다. 서비스가 늘어나도 Firehose는 하나로 유지.

4. **Kinesis Data Firehose**: JSON 로그를 Parquet 포맷으로 자동 변환한다. Parquet은 열 기반 포맷으로 Athena 스캔량을 크게 줄인다.

5. **S3 적재**: Hive 스타일 파티셔닝으로 S3에 저장한다. Athena가 필요한 파티션만 스캔하도록 한다.

### Parquet 변환 방식: Kinesis Data Firehose (확정)

| 방식 | 장점 | 단점 | 결정 |
|------|------|------|------|
| CLI에서 로컬 변환 | 외부 서비스 의존 없음 | 변환 라이브러리 의존성 | 탈락 |
| **Firehose 경유** | **자동 변환, 스트리밍 수집** | **Firehose 비용 $0.029/GB** | **채택** |
| Lambda 후처리 | 유연함 | 인프라 복잡도 증가 | 탈락 |

Firehose를 선택한 이유: 실시간 스트리밍 수집 + Parquet 자동 변환이 한 서비스에서 해결된다.

---

## 3. S3 적재 구조 (Hive Partitioning)

### 디렉토리 구조

```
s3://bucket/logs/
  level=ERROR/domain=payment/year=2026/month=03/day=28/
  level=WARN/domain=auth/year=2026/month=03/day=28/
  level=INFO/domain=order/year=2026/month=03/day=28/
```

### 파티션 키

| 파티션 키 | 설명 | 예시 |
|-----------|------|------|
| `level` | 로그 레벨 | ERROR, WARN, INFO |
| `domain` | 도메인/서비스명 | payment, auth, order |
| `year` | 연도 | 2026 |
| `month` | 월 | 03 |
| `day` | 일 | 28 |

### 로그 구조

```
{로그레벨}-{도메인명}-{에러내용}
```

### Hive Partitioning의 이점

- Athena가 쿼리 조건에 해당하는 파티션만 스캔 (스캔량 최소화 = 비용 최소화)
- `WHERE level='ERROR' AND domain='payment'` 조건 시 해당 파티션만 읽음
- Glue Data Catalog에 파티션 메타데이터가 등록되어 자동 인식

---

## 4. 질의 동작 Flow (Claude Code + MCP Server)

### 아키텍처

```
사용자 (터미널에서 Claude Code 사용)
  |  자연어로 질문
  v
Claude Code
  |  MCP Server 도구 자동 선택 + 호출
  v
MCP Server (TypeScript)
  |  도구별 로직 실행
  v
AWS (Athena 쿼리 실행, 결과 반환)
  |
  v
Claude Code가 결과를 분석하여 자연어 답변 생성
  |
  v
터미널 출력
```

### 핵심 설계 원칙

1. **사용자는 Claude Code와 대화만 하면 됨**: MCP Server 도구가 자동 호출된다. 사용자가 도구 이름을 알 필요 없다.

2. **Claude Code가 AI 역할을 겸함**: 별도의 Bedrock Agent가 불필요하다. Claude Code 자체가 질문 해석 + 결과 분석을 수행한다.

3. **MCP Server는 AWS 연동 전용**: MCP Server는 Athena 쿼리 실행, 인프라 관리 등 AWS 작업만 담당한다. AI 로직은 없다.

4. **설정 기반 최적 쿼리**: 테이블 스키마, 파티션 구조가 설정 파일에 내장되어 있어 매번 알려줄 필요 없이 최적 쿼리가 보장된다.

### MCP Server vs Bash + AWS CLI

MCP Server가 필요한 이유:

- 테이블 스키마, 파티션 구조를 설정에 내장하여 최적 쿼리 보장
- 매번 버킷 이름, 테이블 구조를 알려줄 필요 없음
- 쿼리 비용 자동 추적, 스캔량 제한 가능
- 인프라 세팅 자동화
- 에러 메시지 래핑
- 항상 동일한 동작 보장 (재현성)

---

## 5. MCP Server 도구 목록

| 도구 | 설명 |
|------|------|
| `init-infra` | AWS 리소스 생성 (S3, Firehose, Glue, Athena, IAM) |
| `connect-log-group` | CloudWatch Log Group에 Subscription Filter 설정 |
| `athena-query` | Athena 쿼리 실행 + 결과 반환 |
| `get-cost` | 쿼리 스캔량 + 예상 비용 조회 |
| `update-config` | 설정 파일 읽기/수정 + AWS 리소스 반영 |

---

## 6. 설정 파일 (~/.s3-logwatch/config.yaml)

사용자가 세부 조정 가능한 설정 파일. MCP Server가 이 설정을 기반으로 동작한다.

```yaml
s3:
  bucket: my-custom-log-bucket
  prefix: logs/

firehose:
  delivery_stream: my-stream
  buffer_interval: 300
  buffer_size: 5

schema:
  columns:
    - name: timestamp
      type: timestamp
    - name: level
      type: string
    - name: domain
      type: string
    - name: service
      type: string
    - name: message
      type: string
    - name: trace_id
      type: string

partitioning:
  keys: [level, domain, year, month, day]

athena:
  workgroup: s3-logwatch
  output_location: s3://my-bucket/athena-results/

connections:
  - log_group: /ecs/payment-api
    filter_pattern: ""
  - log_group: /ecs/auth-service
    filter_pattern: "ERROR"
```

### 설정 항목 설명

| 항목 | 설명 |
|------|------|
| `s3` | S3 버킷 이름, prefix |
| `firehose` | Firehose delivery stream 이름, 버퍼 설정 |
| `schema` | Parquet 스키마 (커스텀 필드 추가 가능) |
| `partitioning` | Hive 파티션 키 설정 |
| `athena` | Athena 워크그룹, 출력 위치 |
| `connections` | CloudWatch 연결 목록 + 필터 패턴 |

---

## 7. 기술 스택

| 영역 | 기술 | 선택 이유 |
|------|------|-----------|
| 언어 | **TypeScript** | MCP 공식 SDK가 가장 성숙, AWS SDK v3 지원 |
| MCP SDK | **@modelcontextprotocol/sdk** | TypeScript 공식 MCP SDK |
| AWS SDK | **AWS SDK for JS v3** | TypeScript 네이티브 지원 |
| 배포 | **npm 패키지 또는 로컬 설치** | MCP Server 표준 배포 방식 |
| AI 질의 | **Claude Code** | 이미 사용 중인 도구, 별도 AI 서비스 불필요 |
| 로그 수집 | **CloudWatch Logs + Subscription Filter** | 기존 CloudWatch 로그와 자연스럽게 연동 |
| 스트리밍 | **Kinesis Data Firehose** | Parquet 변환 내장, 실시간 수집 |
| 저장 | **S3 (Hive Partitioning)** | 비용 최저, 무한 확장 |
| 카탈로그 | **AWS Glue Data Catalog** | Athena 테이블 메타데이터 관리 |
| 쿼리 | **Amazon Athena** | S3 직접 쿼리, 스캔량 기반 과금 |

### 이전 스택에서 제거된 항목

| 제거 항목 | 이유 |
|-----------|------|
| Go, Cobra, GoReleaser | MCP Server 전환으로 CLI 바이너리 불필요 |
| Amazon Bedrock Agent + Action Group | Claude Code가 AI 역할을 대체 |
| AWS Lambda | Bedrock Action Group 제거로 불필요 |

### TypeScript 선택 이유

- MCP 공식 SDK(`@modelcontextprotocol/sdk`)가 TypeScript 기반으로 가장 성숙
- AWS SDK for JS v3가 TypeScript 네이티브 지원
- MCP Server는 바이너리 배포가 아닌 npm/로컬 설치이므로 Go의 단일 바이너리 이점이 사라짐
- Claude Code의 MCP 연동이 TypeScript 서버에 최적화

---

## 8. AWS 리소스 목록

`init-infra` 도구가 생성하는 리소스:

| 리소스 | 용도 |
|--------|------|
| **S3 버킷** | 로그 저장소 (Hive Partitioning) |
| **Glue 데이터베이스 + 테이블** | Athena용 테이블 메타데이터 (파티션 키, 스키마 정의) |
| **Kinesis Data Firehose delivery stream** | CloudWatch -> S3 스트리밍, Parquet 변환 |
| **Athena 워크그룹** | 쿼리 실행 환경, 스캔량 제한 설정 |
| **IAM 역할들** | 각 서비스 간 권한 (Firehose -> S3 등) |

`connect-log-group` 도구가 생성하는 리소스:

| 리소스 | 용도 |
|--------|------|
| **Subscription Filter** | CloudWatch Log Group -> Firehose 연결 (도메인/서비스별 필터) |

---

## 9. 비용 구조

### 하루 1GB 로그 기준 월간 비용

| 서비스 | 월 비용 | 비고 |
|--------|---------|------|
| Kinesis Data Firehose | ~$1.41 | $0.029/GB x 30GB + Parquet 변환 |
| S3 저장 | ~$0.14 | Parquet 압축 효과 (원본 대비 크게 절감) |
| Athena | ~$0.30 | 파티셔닝 + Parquet으로 스캔량 최소화 |
| **합계** | **~$2/월** | **AI 비용은 Claude Code 구독에 포함** |

### 이전 대비 변경

- Bedrock 사용량 비용 제거 (Claude Code 구독에 포함)
- Lambda 비용 제거 (Lambda 자체가 제거됨)

### 비용 핵심 원칙

- **"사용 안 하면 비용 $0" 컨셉 유지**: 로그를 안 쌓으면 Firehose 비용도 $0.
- **모든 쿼리 결과에 비용 표시**: `Scanned: 12MB  Cost: $0.00006` 형태로 투명하게 보여줌.
- **파티셔닝 + Parquet = 스캔량 최소화**: Athena 비용($5/TB)을 실질적으로 최소화.

---

## 10. 변하지 않는 것

아키텍처가 Go CLI + Bedrock Agent에서 TypeScript MCP Server + Claude Code로 전환되었지만, 다음은 변하지 않는다:

- **핵심 파이프라인**: App -> CloudWatch Logs -> Subscription Filter -> Firehose -> S3 (Hive Partitioning) -> Athena
- **"사용 안 하면 $0" 컨셉**
- **"사용자가 터미널에서 모든 것을 해결" 전제**
- **Hive Partitioning 구조** (level, domain, year, month, day)
- **로그 구조**: `{로그레벨}-{도메인명}-{내용}`
- **모든 쿼리에 스캔량 + 비용 표시**

---

## 11. v0.1 스코프

### 포함

- [ ] `init-infra` -- AWS 리소스 일괄 생성 (S3, Firehose, Glue, Athena, IAM)
- [ ] `connect-log-group` -- CloudWatch Log Group 연결
- [ ] `athena-query` -- Athena 쿼리 실행 + 결과 반환
- [ ] `get-cost` -- 쿼리 비용 표시
- [ ] `update-config` -- 설정 파일 관리
- [ ] Firehose를 통한 Parquet 변환 + S3 적재
- [ ] Hive Partitioning (level, domain, year, month, day)
- [ ] 설정 파일 (~/.s3-logwatch/config.yaml)

### 미포함 (이후 버전)

- [ ] Slack / Discord / PagerDuty 알림 연동
- [ ] 이상 감지 알고리즘 (Z-score, 새 패턴 탐지)
- [ ] EventBridge 스케줄 기반 자동 감지
- [ ] 대시보드 / 웹 UI

---

## 12. 프로젝트 구조

```
s3-logwatch/
└── mcp-server/
    ├── src/
    │   ├── index.ts          # MCP Server 진입점
    │   └── tools/
    │       ├── init.ts       # init-infra 도구
    │       ├── connect.ts    # connect-log-group 도구
    │       ├── query.ts      # athena-query 도구
    │       ├── cost.ts       # get-cost 도구
    │       └── config.ts     # update-config 도구
    ├── package.json
    └── tsconfig.json
```

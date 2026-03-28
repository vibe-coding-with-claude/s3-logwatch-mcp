# T-004 connect-log-group 결과

## 생성/수정된 파일

| 파일 | 작업 |
|------|------|
| `src/tools/connect.ts` | 신규 생성 - connect-log-group MCP 도구 |
| `src/tools/index.ts` | 수정 - registerConnectTool 등록 추가 |
| `docs/plan/tasks/s3-logwatch/T-004-connect-log-group.task.md` | 수정 - status: done |

## Subscription Filter란?

CloudWatch Log Group에 설정하는 실시간 필터입니다. 조건에 맞는 로그 이벤트를 다른 AWS 서비스(Firehose, Lambda, Kinesis Data Streams)로 자동 전달합니다.

- **빈 필터 패턴(`""`)**: 모든 로그를 전달합니다.
- **특정 패턴(예: `"ERROR"`)**: 해당 문자열이 포함된 로그만 전달합니다.
- **PutSubscriptionFilter API**는 같은 `filterName`이면 덮어씌우는 **upsert 동작**이므로 멱등성이 자동으로 보장됩니다.

## 여러 Log Group -> 하나의 Firehose 구조

```
/ecs/payment-api   --[Subscription Filter]--> |
/ecs/auth-service  --[Subscription Filter]--> |  s3-logwatch-stream (Firehose)
/ecs/order-api     --[Subscription Filter]--> |        |
                                                       v
                                                  S3 (Parquet)
```

- 각 Log Group마다 별도의 Subscription Filter를 만들되, 목적지는 **동일한 Firehose delivery stream**입니다.
- 서비스가 추가되어도 Firehose와 S3 설정은 변경 불필요합니다.
- `connect-log-group` 도구를 반복 호출하면 됩니다.
- 연결된 Log Group 목록은 `~/.s3-logwatch/config.yaml`의 `connections` 배열에 기록됩니다.

## IAM 역할 설계

이 도구는 init-infra에서 만든 Firehose 역할과 **별도의 IAM 역할**을 사용합니다.

| 역할 | Principal (누가 사용) | 권한 (무엇을 할 수 있나) |
|------|----------------------|--------------------------|
| `s3-logwatch-firehose-role` (init-infra) | `firehose.amazonaws.com` | S3 PutObject, Glue GetTable |
| `s3-logwatch-cwl-to-firehose-role` (connect) | `logs.{region}.amazonaws.com` | firehose:PutRecord, firehose:PutRecordBatch |

**왜 역할을 분리하나?**

- AWS IAM 모범사례인 **최소 권한 원칙**을 따릅니다.
- 각 역할의 Trust Policy(Principal)가 다릅니다: Firehose 서비스 vs CloudWatch Logs 서비스.
- 하나의 역할에 모든 권한을 몰아넣으면 보안 위험이 커집니다.

**멱등성:**
- 역할이 이미 존재하면 ARN만 반환하고, 정책은 항상 업데이트합니다.
- `PutRolePolicy`는 같은 PolicyName이면 덮어씌우는 upsert 동작입니다.

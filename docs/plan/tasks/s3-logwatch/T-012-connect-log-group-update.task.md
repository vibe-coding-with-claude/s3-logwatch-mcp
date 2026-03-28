# Task: connect-log-group 수정 — 도메인 지정 필수

> **Spec:** docs/s3-logwatch-tech-decisions.md#2
> **Priority:** 🟠 P1 — Firehose 생성 후 연결 가능
> **Status:** done
> **Depends on:** T-009, T-010

## Context
Log Group 연결 시 어떤 도메인에 속하는지 지정해야 한다.
Firehose가 로그의 domain 필드를 보고 S3 경로를 분기하므로,
CloudWatch Logs → Firehose 전달 시 domain 정보가 포함되어야 한다.

## be
- [ ] `src/tools/connect.ts` 수정:
  - 입력 파라미터에 `domain` 추가 (필수, string)
  - domain이 config.domains에 존재하는지 검증
  - config.yaml connections에 domain 포함하여 저장
- [ ] Subscription Filter 이름에 domain 포함: `s3-logwatch-{domain}-{log_group_sanitized}`

## qa
- [ ] domain 미지정 시 에러 메시지
- [ ] 존재하지 않는 domain 지정 시 에러
- [ ] 정상 연결 + config.yaml 업데이트 확인

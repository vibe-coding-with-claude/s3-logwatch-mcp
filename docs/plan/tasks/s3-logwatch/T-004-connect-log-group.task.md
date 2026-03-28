# Task: connect-log-group 도구 구현

> **Spec:** docs/s3-logwatch-tech-decisions.md#2-로그-수집-파이프라인
> **Priority:** 🟠 P1 — 로그 수집 파이프라인의 핵심
> **Status:** done
> **Depends on:** T-003

## Context
CloudWatch Log Group에 Subscription Filter를 설정하여 Firehose로 로그를 전달한다.
여러 Log Group이 하나의 Firehose로 모이는 구조.
사용자가 "payment-api 로그 그룹 연결해줘"라고 말하면 이 도구가 호출된다.

## be
- [ ] `src/tools/connect.ts` — `connect-log-group` MCP 도구 구현
- [ ] 입력: log_group 이름, filter_pattern (선택)
- [ ] CloudWatch Subscription Filter 생성
  - 대상: config.yaml의 Firehose delivery stream
  - 필터 패턴: 사용자 지정 또는 빈 문자열 (전체)
- [ ] config.yaml의 `connections` 목록에 추가
- [ ] 이미 연결된 Log Group 재연결 시 업데이트

## qa
- [ ] 새 Log Group 연결 성공
- [ ] 필터 패턴 적용 확인 (예: "ERROR"만 필터링)
- [ ] config.yaml connections 목록 업데이트 확인

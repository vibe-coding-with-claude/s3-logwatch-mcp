# Task: Slack/Discord 알림 — 에러 패턴 감지

> **Priority:** 🟢 P3
> **Status:** done
> **제약:** 코드만 작성, 외부 서비스 호출 금지

## be
- [x] `src/tools/alert.ts` — set-alert MCP 도구
  - 알림 규칙 설정: domain, level, 키워드, threshold
  - config.yaml에 alerts 섹션 추가
  - webhook URL 설정 (Slack/Discord)
- [x] `src/tools/check-alert.ts` — check-alerts MCP 도구
  - 설정된 규칙에 따라 Athena 쿼리 실행
  - threshold 초과 시 webhook POST (코드만, 실제 호출 금지)
  - 결과 요약 반환
- [x] AppConfig에 AlertConfig 타입 추가
- [x] `src/tools/index.ts`에 등록
- [x] `npx tsc --noEmit` 통과

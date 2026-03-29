# Task: disconnect-log-group 도구 — Log Group 연결 해제

> **Priority:** 🟠 P1
> **Status:** done
> **제약:** 코드만 작성, AWS 배포 금지

## be
- [ ] `src/tools/disconnect.ts` — disconnect-log-group MCP 도구
  - Subscription Filter 삭제
  - config.yaml connections에서 해당 항목 제거
  - 존재하지 않는 필터는 스킵 (멱등성)
- [ ] `src/tools/index.ts`에 등록
- [ ] `npx tsc --noEmit` 통과

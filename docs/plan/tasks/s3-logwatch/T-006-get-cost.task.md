# Task: get-cost 도구 구현

> **Spec:** docs/s3-logwatch-tech-decisions.md#9-비용-구조
> **Priority:** 🟡 P2 — 핵심 기능 완료 후 추가
> **Status:** done
> **Depends on:** T-005

## Context
"지금까지 쿼리 비용 얼마야?"라고 물으면 세션 내 누적 쿼리 비용을 보여준다.
"사용 안 하면 비용 $0" 컨셉의 투명성을 위한 도구.

## be
- [ ] `src/tools/cost.ts` — `get-cost` MCP 도구 구현
- [ ] 세션 내 누적 스캔량 + 예상 비용 반환
- [ ] 쿼리별 비용 내역 (쿼리 텍스트, 스캔량, 비용)
- [ ] Athena $5/TB 기준 계산

## qa
- [ ] 쿼리 3회 실행 후 get-cost → 누적 비용 정확성 확인
- [ ] 쿼리 0회 상태에서 get-cost → "쿼리 없음" 메시지 확인

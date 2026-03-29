# Task: 쿼리 결과 캐싱

> **Priority:** 🟢 P3
> **Status:** done
> **제약:** 코드만 작성

## be
- [ ] `src/tools/query.ts` 수정
  - 동일 SQL + 동일 시간 범위의 쿼리 결과를 메모리 캐시
  - TTL 설정 (기본 5분)
  - 캐시 히트 시 Athena 호출 스킵 → 비용 $0
  - 캐시 상태를 결과에 표시 ("cached" vs "fresh")
- [ ] `npx tsc --noEmit` 통과

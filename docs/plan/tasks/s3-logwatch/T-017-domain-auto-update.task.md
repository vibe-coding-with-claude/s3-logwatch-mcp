# Task: 도메인 추가 시 Athena 테이블 자동 갱신

> **Priority:** 🔴 P0
> **Status:** done
> **제약:** 코드만 작성, AWS 배포 금지

## be
- [ ] `src/tools/config.ts`의 update-config 수정
  - domains 변경 감지 시 ALTER TABLE로 projection.domain.values 업데이트
  - executeAthenaDDL 재사용 (init.ts에서 export됨)
- [ ] `npx tsc --noEmit` 통과

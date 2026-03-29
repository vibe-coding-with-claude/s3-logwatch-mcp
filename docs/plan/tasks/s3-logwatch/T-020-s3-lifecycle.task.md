# Task: S3 Lifecycle Rule — 로그 보존 정책

> **Priority:** 🟡 P2
> **Status:** done
> **제약:** 코드만 작성, AWS 배포 금지

## be
- [ ] `AppConfig`에 retention 설정 추가 (예: retention_days: 90)
- [ ] `src/tools/init.ts`에 S3 Lifecycle Rule 생성 로직 추가
  - 지정 일수 후 Glacier로 이동 또는 삭제
  - config.yaml에서 읽어서 적용
- [ ] DEFAULT_CONFIG에 기본값 추가
- [ ] `npx tsc --noEmit` 통과

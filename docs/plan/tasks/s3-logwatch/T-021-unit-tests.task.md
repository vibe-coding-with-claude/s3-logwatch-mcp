# Task: 단위 테스트 — Vitest 설정 + 핵심 로직 테스트

> **Priority:** 🟡 P2
> **Status:** done

## be
- [x] vitest 설치 (devDependencies)
- [x] vitest.config.ts 생성
- [x] package.json에 "test" 스크립트 추가
- [x] 테스트 파일 작성:
  - `src/__tests__/config.test.ts` — loadConfig, saveConfig, validateConfig, mergeWithDefaults
  - `src/__tests__/build-ddl.test.ts` — buildCreateTableDDL 출력 검증
- [x] `npm test` 통과 (31 tests, 2 suites)

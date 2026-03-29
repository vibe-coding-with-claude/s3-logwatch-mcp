# Task: destroy-infra 도구 — AWS 리소스 정리

> **Priority:** 🟠 P1
> **Status:** done
> **제약:** 코드만 작성, AWS 배포 금지

## be
- [ ] `src/tools/destroy.ts` — destroy-infra MCP 도구
  - 역순으로 리소스 삭제: Firehose → IAM → Athena 테이블/DB → S3 (선택적)
  - S3 버킷은 기본적으로 보존 (데이터 유실 방지), force 옵션으로 삭제
  - 각 리소스별 삭제 결과 반환
  - 멱등성: 없는 리소스는 스킵
- [ ] `src/tools/index.ts`에 등록
- [ ] `npx tsc --noEmit` 통과

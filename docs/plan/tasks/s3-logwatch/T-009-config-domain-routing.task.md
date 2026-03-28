# Task: Config 구조 변경 — 도메인별 S3 경로 지원

> **Spec:** docs/s3-logwatch-tech-decisions.md
> **Priority:** 🔴 P0 — 모든 후속 작업의 전제
> **Status:** done
> **Depends on:** T-002

## Context
현재 모든 로그가 하나의 S3 prefix(`logs/`)에 저장된다.
도메인별로 S3 경로를 분리해야 한다.
예: `seungjae/user/2026/03/28/`, `seungjae/order/2026/03/28/`

## be
- [ ] `ConnectionConfig` 타입에 `domain` 필드 추가
- [ ] `S3Config`에 `base_prefix` 추가 (예: "seungjae/")
- [ ] `PartitionConfig.keys`를 `["year", "month", "day"]`로 변경 (level, domain 제거 — domain은 폴더, level은 로그 내 필드)
- [ ] `DomainConfig` 타입 추가 (name, s3_prefix)
- [ ] `AppConfig`에 `domains: DomainConfig[]` 추가
- [ ] `DEFAULT_CONFIG` 업데이트 (예시 도메인: user, order, payment, auth, notification)
- [ ] 기본값 예시:
  ```yaml
  s3:
    bucket: s3-logwatch-logs
    base_prefix: seungjae/
  domains:
    - name: user
      s3_prefix: seungjae/user/
    - name: order
      s3_prefix: seungjae/order/
    - name: payment
      s3_prefix: seungjae/payment/
    - name: auth
      s3_prefix: seungjae/auth/
    - name: notification
      s3_prefix: seungjae/notification/
  ```
- [ ] `loadConfig()`, `mergeWithDefaults()`, `validateConfig()` 수정
- [ ] `npx tsc --noEmit` 통과

## qa
- [ ] 기존 config.yaml 호환성 (없는 필드는 기본값)
- [ ] domains가 비어있으면 검증 에러

# Task: Lambda 변환 프로세서 — CloudWatch gzip 해제 + domain 매핑

> **Priority:** 🔴 P0
> **Status:** done
> **제약:** 코드만 작성, AWS 배포 금지

## be
- [ ] `src/lambda/transformer.ts` — Firehose Lambda 변환 핸들러
  - gzip 해제 + base64 디코딩
  - logEvents 배열 → 개별 레코드 분리
  - logGroup → domain 매핑 (환경변수 DOMAIN_MAPPING에서 JSON 읽기)
  - 출력: {domain, log_group, log_stream, timestamp, message}
- [ ] `src/tools/init.ts`에 Lambda 생성 로직 추가 (코드만, 실행 금지)
  - Lambda 함수 생성
  - Lambda용 IAM 역할 생성
  - Firehose에 Lambda 프로세서 연결
- [ ] `npx tsc --noEmit` 통과

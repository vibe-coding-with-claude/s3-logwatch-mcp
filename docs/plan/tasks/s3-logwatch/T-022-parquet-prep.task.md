# Task: Parquet 전환 준비 — 설정 + 문서

> **Priority:** 🟢 P3
> **Status:** done
> **제약:** 코드만 작성, AWS 배포 금지

## be
- [ ] `AppConfig`에 `format: "json" | "parquet"` 옵션 추가 (기본값: json)
- [ ] `src/tools/init.ts`의 Firehose 생성에서 format에 따라 분기:
  - json: 현재 방식 유지
  - parquet: DataFormatConversionConfiguration 활성화
- [ ] buildCreateTableDDL에서 format에 따라 SerDe 분기 (JSON vs Parquet)
- [ ] `npx tsc --noEmit` 통과

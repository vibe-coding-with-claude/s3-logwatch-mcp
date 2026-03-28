# Task: 설정 파일 관리 (config.yaml)

> **Spec:** docs/s3-logwatch-tech-decisions.md#6-설정-파일
> **Priority:** 🔴 P0 — 모든 도구가 설정 파일을 참조함
> **Status:** done
> **Depends on:** T-001

## Context
MCP Server의 모든 도구는 `~/.s3-logwatch/config.yaml`을 읽어서 동작한다.
버킷 이름, Firehose 설정, 스키마, 파티션 키 등이 여기에 정의된다.

## be
- [ ] `src/config.ts` — config.yaml 로드/저장 유틸리티
  - `~/.s3-logwatch/config.yaml` 경로에서 읽기
  - 파일 없으면 기본값으로 생성
  - YAML 파싱 → TypeScript 타입으로 변환
- [ ] 설정 타입 정의 (`S3Config`, `FirehoseConfig`, `SchemaConfig`, `AthenaConfig`, `ConnectionConfig`)
- [ ] `src/tools/config.ts` — `update-config` MCP 도구 구현
  - 현재 설정 조회
  - 설정 항목 수정
  - 수정 후 검증 (필수 필드 누락 체크)

## qa
- [ ] config.yaml 없는 상태에서 기본값 생성 확인
- [ ] 설정 읽기/쓰기 라운드트립 테스트
- [ ] 잘못된 YAML 입력 시 에러 메시지 확인

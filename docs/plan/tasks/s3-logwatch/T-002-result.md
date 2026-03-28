# T-002 결과: 설정 파일 관리 (config.yaml) + update-config MCP 도구

## 생성/수정된 파일 목록

| 파일 | 역할 |
|------|------|
| `mcp-server/src/config.ts` | 설정 로드/저장 유틸리티 + TypeScript 타입 정의 |
| `mcp-server/src/tools/config.ts` | update-config MCP 도구 구현 |
| `mcp-server/src/tools/index.ts` | 도구 배럴(barrel) 파일 - registerConfigTool 등록 추가 |
| `mcp-server/src/index.ts` | registerTools() 호출로 도구 등록 연결 |

## 주요 설계 결정과 이유

### 1. 설정 파일 경로: `~/.s3-logwatch/config.yaml`
- Unix 관례에 따라 사용자 홈 디렉토리 하위에 저장합니다.
- 프로젝트 디렉토리와 무관하게 어디서든 동일한 설정을 사용합니다.

### 2. YAML 포맷 선택
- JSON보다 사람이 읽고 직접 수정하기 쉽습니다.
- 주석을 달 수 있어 설정 항목 설명에 유리합니다.

### 3. 기본값 자동 생성
- 파일이 없으면 DEFAULT_CONFIG로 자동 생성합니다.
- 파일이 있지만 일부 필드가 없으면 기본값과 병합(merge)합니다.
- 사용자가 처음 사용할 때 별도 설정 없이 바로 동작하도록 합니다.

### 4. 도구 파라미터를 "action + path + value"로 설계
- action: "get" (조회) 또는 "set" (수정)
- path: 점(.)으로 구분된 경로 (예: "s3.bucket")
- value: JSON 문자열
- 하나의 도구로 조회/수정을 모두 처리하여 Claude가 도구를 선택하기 쉽게 합니다.

### 5. 검증 후 저장 패턴
- set 시 먼저 메모리에서 값을 변경하고, validateConfig()로 검증합니다.
- 검증 실패 시 파일에 저장하지 않아 잘못된 설정이 기록되는 것을 방지합니다.

### 6. 도구 등록 패턴: register 함수 분리
- 각 도구 파일에서 `registerXxxTool(server)` 함수를 export합니다.
- `tools/index.ts`에서 모든 register 함수를 모아 `registerTools(server)`로 제공합니다.
- `src/index.ts`에서는 `registerTools(server)` 한 줄로 모든 도구를 등록합니다.

## 사용한 라이브러리와 선택 이유

| 라이브러리 | 용도 | 선택 이유 |
|-----------|------|-----------|
| `yaml` (v2) | YAML 파싱/직렬화 | Node.js에서 가장 표준적인 YAML 라이브러리. package.json에 이미 포함. |
| `zod` (v4) | MCP 도구 입력 파라미터 검증 | MCP SDK가 zod 스키마를 기반으로 파라미터 검증 및 Claude에게 스키마 전달. SDK 의존성으로 이미 설치됨. |

## 코드 구조 설명

### config.ts 흐름도

```
loadConfig() 호출
  |
  v
~/.s3-logwatch/ 디렉토리 존재? --[No]--> 디렉토리 생성
  |[Yes]
  v
config.yaml 파일 존재? --[No]--> 기본값으로 파일 생성 후 반환
  |[Yes]
  v
YAML 파일 읽기 + 파싱
  |
  v
기본값과 병합 (누락 필드 채우기)
  |
  v
AppConfig 객체 반환
```

### tools/config.ts 흐름도

```
Claude Code가 update-config 도구 호출
  |
  v
action = "get"? --[Yes]--> loadConfig() -> 설정 반환
  |[No]
  v
action = "set"
  |
  v
path, value 필수 확인
  |
  v
loadConfig() -> 메모리에서 값 수정
  |
  v
validateConfig() 검증
  |
  v
검증 통과? --[No]--> 에러 메시지 반환 (파일 미저장)
  |[Yes]
  v
saveConfig() -> 성공 메시지 반환
```

### TypeScript 타입 계층

```
AppConfig (전체 설정)
  ├── s3: S3Config
  ├── firehose: FirehoseConfig
  ├── schema: SchemaConfig
  │     └── columns: SchemaColumn[]
  ├── partitioning: PartitionConfig
  ├── athena: AthenaConfig
  └── connections: ConnectionConfig[]
```

## 타입 체크

`npx tsc --noEmit` 실행 필요. (bash 권한 필요)

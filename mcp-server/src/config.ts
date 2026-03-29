/**
 * 설정 파일 관리 모듈 (config.ts)
 *
 * 이 파일의 역할:
 * 1. ~/.s3-logwatch/config.yaml 파일을 읽고 쓰는 유틸리티를 제공합니다.
 * 2. 설정의 TypeScript 타입을 정의합니다.
 * 3. 파일이 없으면 기본값으로 자동 생성합니다.
 *
 * 왜 YAML인가?
 * - JSON보다 사람이 읽고 수정하기 쉽습니다.
 * - 주석을 달 수 있어서 설정 항목 설명을 넣을 수 있습니다.
 * - AWS CloudFormation 등 인프라 도구에서도 YAML을 많이 사용합니다.
 *
 * 왜 홈 디렉토리(~/.s3-logwatch/)에 저장하나?
 * - 프로젝트와 무관하게 사용자별 설정을 유지하기 위해서입니다.
 * - Unix 관례: 사용자 설정은 ~/.프로그램명/ 디렉토리에 저장합니다.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
// yaml 패키지: YAML 문자열 <-> JavaScript 객체 변환을 담당합니다
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// =============================================================
// TypeScript 타입 정의
// =============================================================
// 왜 타입을 정의하나?
// - TypeScript의 핵심 장점입니다. 설정 객체의 구조를 명확히 규정해서
//   잘못된 필드 접근이나 오타를 컴파일 시점에 잡아줍니다.
// - 예: config.s3.buckt (오타) -> 컴파일 에러 발생

/**
 * S3 버킷 설정
 * - bucket: 로그가 저장되는 S3 버킷 이름
 * - base_prefix: 버킷 내 기본 경로 접두사 (예: "seungjae/")
 *
 * 왜 prefix → base_prefix로 변경했나?
 * - 도메인별로 S3 경로를 분리하면서, 기존 prefix는 "기본 접두사" 역할만 합니다.
 * - 실제 저장 경로는 DomainConfig.s3_prefix가 결정합니다.
 *   예: base_prefix="seungjae/", domain.s3_prefix="seungjae/user/"
 */
export interface S3Config {
  bucket: string;
  base_prefix: string;
  retention_days?: number;        // 로그 보존 일수 (기본 90). 이 일수가 지나면 객체를 삭제합니다.
  glacier_transition_days?: number; // Glacier 이동 일수 (기본 없음). 설정 시 해당 일수 후 Glacier로 전환합니다.
}

/**
 * 도메인별 S3 경로 설정
 * - name: 도메인 이름 (예: "user", "order")
 * - s3_prefix: 해당 도메인의 S3 경로 접두사 (예: "seungjae/user/")
 *
 * 왜 도메인별 경로가 필요한가?
 * - 도메인마다 로그를 분리 저장하면, Athena 쿼리 시 특정 도메인만 스캔할 수 있습니다.
 * - 비용 절감: 전체 로그를 읽지 않고 필요한 도메인 폴더만 읽습니다.
 */
export interface DomainConfig {
  name: string;
  s3_prefix: string;
}

/**
 * Kinesis Data Firehose 설정
 * - delivery_stream: Firehose 스트림 이름
 * - buffer_interval: 버퍼링 간격 (초). 이 시간마다 S3에 파일을 씁니다.
 * - buffer_size: 버퍼 크기 (MB). 이 크기가 차면 S3에 파일을 씁니다.
 */
export interface FirehoseConfig {
  delivery_stream: string;
  buffer_interval: number;
  buffer_size: number;
  format: "json" | "parquet";  // 데이터 저장 포맷 (기본값: "json"). parquet 선택 시 DataFormatConversion 활성화.
}

/**
 * 스키마 컬럼 하나의 정의
 * - name: 컬럼 이름 (예: "timestamp", "level")
 * - type: 컬럼 타입 (예: "string", "timestamp")
 *
 * Parquet 파일과 Athena 테이블의 스키마를 정의하는 데 사용됩니다.
 */
export interface SchemaColumn {
  name: string;
  type: string;
}

/**
 * 전체 스키마 설정
 * - columns: 로그 테이블의 컬럼 목록
 */
export interface SchemaConfig {
  columns: SchemaColumn[];
}

/**
 * 파티셔닝 설정
 * - keys: Hive 파티션 키 목록 (예: ["year", "month", "day"])
 *
 * 파티션이란?
 * S3에 저장할 때 디렉토리 구조로 데이터를 나누는 것입니다.
 * 예: s3://bucket/seungjae/user/year=2026/month=03/day=28/
 * Athena가 쿼리할 때 필요한 파티션만 읽어서 비용을 절약합니다.
 *
 * 왜 level과 domain을 파티션 키에서 제거했나?
 * - domain은 S3 폴더 경로(DomainConfig.s3_prefix)로 이미 분리됩니다.
 * - level은 로그 내 필드로 남겨두고, 파티션이 아닌 Athena WHERE 절로 필터합니다.
 * - 파티션 키가 많으면 S3에 소규모 파일이 너무 많아져 오히려 성능이 나빠집니다.
 */
export interface PartitionConfig {
  keys: string[];
}

/**
 * Amazon Athena 설정
 * - workgroup: Athena 워크그룹 이름 (쿼리 실행 환경)
 * - output_location: 쿼리 결과가 저장되는 S3 경로
 */
export interface AthenaConfig {
  workgroup: string;
  output_location: string;
  database: string;   // Athena 데이터베이스 이름 (기본: s3_logwatch)
  table: string;      // Athena 테이블 이름 (기본: logs)
}

/**
 * 알림 규칙 설정
 * - name: 알림 이름 (예: "payment-errors")
 * - domain: 대상 도메인 (예: "payment")
 * - level: 로그 레벨 필터 (예: "ERROR"). 생략 시 모든 레벨.
 * - keyword: 메시지 키워드 (예: "timeout"). 생략 시 키워드 필터 없음.
 * - threshold: 이 건수를 초과하면 알림 발생
 * - period_minutes: 최근 N분 기준으로 집계
 */
export interface AlertRule {
  name: string;
  domain: string;
  level?: string;
  keyword?: string;
  threshold: number;
  period_minutes: number;
}

/**
 * 알림 설정
 * - webhook_url: Slack/Discord webhook URL (선택)
 * - rules: 알림 규칙 목록
 */
export interface AlertConfig {
  webhook_url?: string;
  rules: AlertRule[];
}

/**
 * CloudWatch Log Group 연결 설정
 * - log_group: CloudWatch Log Group 이름 (예: "/ecs/payment-api")
 * - filter_pattern: 구독 필터 패턴 (빈 문자열이면 모든 로그를 수집)
 * - domain: 이 로그 그룹이 속하는 도메인 이름 (예: "user", "order")
 *
 * connect-log-group 도구로 연결을 추가하면 여기에 기록됩니다.
 *
 * 왜 domain 필드를 추가했나?
 * - 로그 그룹과 도메인의 매핑을 설정에 기록해야,
 *   어떤 로그가 어떤 S3 경로로 가는지 추적할 수 있습니다.
 */
export interface ConnectionConfig {
  log_group: string;
  filter_pattern: string;
  domain: string;
}

/**
 * 전체 설정을 하나로 모은 타입
 *
 * 왜 하나의 인터페이스로 모으나?
 * - 설정 파일의 전체 구조를 한눈에 파악할 수 있습니다.
 * - 함수 간에 설정을 전달할 때 타입 안전성을 보장합니다.
 */
/**
 * AWS 리소스 이름 설정
 * 사용자가 모든 리소스 이름을 자유롭게 변경할 수 있습니다.
 */
export interface ResourceNamesConfig {
  firehose_role: string;              // Firehose IAM 역할 (기본: s3-logwatch-firehose-role)
  lambda_role: string;                // Lambda IAM 역할 (기본: s3-logwatch-lambda-role)
  lambda_function: string;            // Lambda 함수 이름 (기본: s3-logwatch-transformer)
  cwl_to_firehose_role: string;       // CW→Firehose IAM 역할 (기본: s3-logwatch-cwl-to-firehose-role)
}

export interface AppConfig {
  /** AWS 리전 (기본값: ap-northeast-2). 사용자가 config.yaml에서 변경 가능. */
  region: string;
  s3: S3Config;
  firehose: FirehoseConfig;
  schema: SchemaConfig;
  partitioning: PartitionConfig;
  athena: AthenaConfig;
  /** AWS 리소스 이름. 모든 이름을 사용자가 변경 가능. */
  resource_names: ResourceNamesConfig;
  /** 도메인별 S3 경로 목록. 각 도메인은 독립적인 S3 prefix를 가집니다. */
  domains: DomainConfig[];
  connections: ConnectionConfig[];
  /** 알림 설정: webhook URL과 알림 규칙 목록 */
  alerts: AlertConfig;
}

// =============================================================
// 기본값 정의
// =============================================================
// 왜 기본값이 필요한가?
// - 사용자가 처음 실행할 때 설정 파일이 없으므로, 합리적인 기본값으로 시작합니다.
// - "s3-logwatch"라는 프로젝트 이름을 기반으로 리소스 이름을 정합니다.

/** 설정 파일이 없을 때 사용되는 기본 설정 */
export const DEFAULT_CONFIG: AppConfig = {
  region: "ap-northeast-2",
  s3: {
    bucket: "s3-logwatch-logs-ap2",
    base_prefix: "seungjae/",
    retention_days: 90, // 90일 후 S3 객체 삭제
  },
  firehose: {
    delivery_stream: "s3-logwatch-stream",
    buffer_interval: 300, // 5분 (초 단위)
    buffer_size: 5, // 5MB
    format: "json", // JSON Lines 포맷으로 저장 (parquet 선택 시 DataFormatConversion 활성화)
  },
  schema: {
    columns: [
      { name: "timestamp", type: "timestamp" },
      { name: "level", type: "string" },
      { name: "domain", type: "string" },
      { name: "service", type: "string" },
      { name: "message", type: "string" },
      { name: "trace_id", type: "string" },
    ],
  },
  partitioning: {
    // 왜 year/month/day만 남겼나?
    // - domain은 S3 폴더 경로로 분리 (DomainConfig.s3_prefix)
    // - level은 로그 JSON 내 필드로, Athena WHERE 절로 필터
    keys: ["year", "month", "day"],
  },
  athena: {
    workgroup: "s3-logwatch",
    output_location: "s3://s3-logwatch-logs-ap2/athena-results/",
    database: "s3_logwatch",
    table: "logs",
  },
  resource_names: {
    firehose_role: "s3-logwatch-firehose-role",
    lambda_role: "s3-logwatch-lambda-role",
    lambda_function: "s3-logwatch-transformer",
    cwl_to_firehose_role: "s3-logwatch-cwl-to-firehose-role",
  },
  // 도메인별 S3 경로: 각 도메인의 로그가 독립적인 S3 경로에 저장됩니다.
  domains: [
    { name: "user", s3_prefix: "seungjae/user/" },
    { name: "order", s3_prefix: "seungjae/order/" },
    { name: "payment", s3_prefix: "seungjae/payment/" },
    { name: "auth", s3_prefix: "seungjae/auth/" },
    { name: "notification", s3_prefix: "seungjae/notification/" },
  ],
  connections: [],
  alerts: { rules: [] },
};

// =============================================================
// 설정 파일 경로
// =============================================================
// homedir(): 현재 사용자의 홈 디렉토리를 반환합니다 (예: /Users/seungjae)
// join(): 경로 조각들을 OS에 맞게 합칩니다 (Mac: /, Windows: \)

/** 설정 디렉토리 경로: ~/.s3-logwatch/ */
const CONFIG_DIR = join(homedir(), ".s3-logwatch");

/** 설정 파일 경로: ~/.s3-logwatch/config.yaml */
const CONFIG_PATH = join(CONFIG_DIR, "config.yaml");

// =============================================================
// 설정 로드 함수
// =============================================================

/**
 * config.yaml을 읽어서 AppConfig 객체로 반환합니다.
 *
 * 동작 흐름:
 * 1. 설정 디렉토리가 없으면 생성합니다 (mkdir -p와 동일)
 * 2. 설정 파일이 없으면 기본값으로 파일을 생성합니다
 * 3. YAML 파일을 읽어서 JavaScript 객체로 파싱합니다
 * 4. 타입 캐스팅하여 반환합니다
 *
 * 왜 매번 파일에서 읽나?
 * - 사용자가 에디터로 직접 수정할 수 있으므로, 항상 최신 상태를 반영합니다.
 * - MCP 도구는 호출 간에 상태를 유지하지 않으므로, 파일이 곧 상태 저장소입니다.
 */
export function loadConfig(): AppConfig {
  // 디렉토리가 없으면 생성 (recursive: true = 중간 디렉토리도 자동 생성)
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }

  // 파일이 없으면 기본값으로 생성
  if (!existsSync(CONFIG_PATH)) {
    saveConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }

  // YAML 파일 읽기 + 파싱
  // readFileSync: 파일을 동기적으로 읽습니다 (비동기 불필요: 설정 파일은 작음)
  // parseYaml: YAML 문자열 -> JavaScript 객체로 변환
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const parsed: unknown = parseYaml(raw);

  // 파싱 결과가 null/undefined면 기본값 반환
  // (빈 파일이거나 YAML이 잘못된 경우)
  if (!parsed || typeof parsed !== "object") {
    return { ...DEFAULT_CONFIG };
  }

  // 기본값과 병합: 파일에 없는 필드는 기본값으로 채웁니다
  // 왜 병합하나? 사용자가 일부 필드만 수정했을 때 나머지는 기본값이 적용되도록.
  return mergeWithDefaults(parsed as Partial<AppConfig>);
}

// =============================================================
// 설정 저장 함수
// =============================================================

/**
 * AppConfig 객체를 config.yaml 파일에 저장합니다.
 *
 * stringify 옵션 설명:
 * - indent: 2 -> 들여쓰기를 2칸으로 (가독성)
 * - lineWidth: 0 -> 줄바꿈하지 않음 (긴 문자열도 한 줄로)
 */
export function saveConfig(config: AppConfig): void {
  // 디렉토리 존재 확인 (저장 시에도 안전하게)
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }

  const yamlString = stringifyYaml(config, {
    indent: 2,
    lineWidth: 0,
  });

  writeFileSync(CONFIG_PATH, yamlString, "utf-8");
}

// =============================================================
// 설정 검증 함수
// =============================================================

/**
 * 설정의 필수 필드가 모두 존재하는지 검증합니다.
 *
 * 왜 검증이 필요한가?
 * - update-config 도구로 설정을 수정할 때, 필수 필드를 실수로 지울 수 있습니다.
 * - 빈 문자열이나 빈 배열도 잡아냅니다.
 *
 * @returns 에러 메시지 배열 (빈 배열이면 검증 통과)
 */
export function validateConfig(config: AppConfig): string[] {
  const errors: string[] = [];

  // S3 설정 검증
  if (!config.s3?.bucket) {
    errors.push("s3.bucket은 필수 항목입니다.");
  }
  if (!config.s3?.base_prefix) {
    errors.push("s3.base_prefix는 필수 항목입니다.");
  }

  // S3 retention 검증: 설정된 경우 양수여야 합니다
  if (
    config.s3?.retention_days != null &&
    (typeof config.s3.retention_days !== "number" || config.s3.retention_days <= 0)
  ) {
    errors.push("s3.retention_days는 0보다 큰 숫자여야 합니다.");
  }
  if (
    config.s3?.glacier_transition_days != null &&
    (typeof config.s3.glacier_transition_days !== "number" || config.s3.glacier_transition_days <= 0)
  ) {
    errors.push("s3.glacier_transition_days는 0보다 큰 숫자여야 합니다.");
  }

  // Firehose 설정 검증
  if (!config.firehose?.delivery_stream) {
    errors.push("firehose.delivery_stream은 필수 항목입니다.");
  }
  if (
    config.firehose?.buffer_interval == null ||
    config.firehose.buffer_interval <= 0
  ) {
    errors.push("firehose.buffer_interval은 0보다 큰 숫자여야 합니다.");
  }
  if (
    config.firehose?.buffer_size == null ||
    config.firehose.buffer_size <= 0
  ) {
    errors.push("firehose.buffer_size는 0보다 큰 숫자여야 합니다.");
  }

  // Firehose format 검증: "json" 또는 "parquet"만 허용합니다
  if (
    config.firehose?.format != null &&
    config.firehose.format !== "json" &&
    config.firehose.format !== "parquet"
  ) {
    errors.push('firehose.format은 "json" 또는 "parquet"이어야 합니다.');
  }

  // 스키마 검증
  if (!config.schema?.columns || config.schema.columns.length === 0) {
    errors.push("schema.columns에 최소 1개 이상의 컬럼이 필요합니다.");
  }

  // 파티셔닝 검증
  if (!config.partitioning?.keys || config.partitioning.keys.length === 0) {
    errors.push("partitioning.keys에 최소 1개 이상의 키가 필요합니다.");
  }

  // Athena 설정 검증
  if (!config.athena?.workgroup) {
    errors.push("athena.workgroup은 필수 항목입니다.");
  }
  if (!config.athena?.output_location) {
    errors.push("athena.output_location은 필수 항목입니다.");
  }

  // 도메인 설정 검증: 최소 1개 이상의 도메인이 필요합니다.
  // 왜? 도메인이 없으면 로그를 저장할 S3 경로를 결정할 수 없습니다.
  if (!Array.isArray(config.domains) || config.domains.length === 0) {
    errors.push("domains에 최소 1개 이상의 도메인이 필요합니다.");
  } else {
    // 각 도메인의 필수 필드 검증
    for (const [i, domain] of config.domains.entries()) {
      if (!domain.name) {
        errors.push(`domains[${i}].name은 필수 항목입니다.`);
      }
      if (!domain.s3_prefix) {
        errors.push(`domains[${i}].s3_prefix는 필수 항목입니다.`);
      }
    }
  }

  // connections는 빈 배열이 허용됨 (아직 연결이 없을 수 있음)
  if (!Array.isArray(config.connections)) {
    errors.push("connections는 배열이어야 합니다.");
  }

  return errors;
}

// =============================================================
// 내부 유틸리티: 기본값 병합
// =============================================================

/**
 * 사용자 설정과 기본값을 병합합니다.
 *
 * 스프레드 연산자(...)를 사용한 얕은 병합(shallow merge):
 * - { ...DEFAULT_CONFIG.s3, ...partial.s3 }
 * - 기본값을 먼저 펼치고, 사용자 값을 덮어씌웁니다.
 * - 사용자가 지정하지 않은 필드는 기본값이 유지됩니다.
 *
 * 왜 깊은 병합(deep merge)을 하지 않나?
 * - 설정 구조가 2단계(s3.bucket 등)로 단순해서 얕은 병합으로 충분합니다.
 * - 깊은 병합은 라이브러리 의존성이 추가되고, 배열 병합 규칙이 복잡해집니다.
 */
export function mergeWithDefaults(partial: Partial<AppConfig>): AppConfig {
  return {
    region: partial.region ?? DEFAULT_CONFIG.region,
    s3: {
      ...DEFAULT_CONFIG.s3,
      ...(partial.s3 ?? {}),
    },
    firehose: {
      ...DEFAULT_CONFIG.firehose,
      ...(partial.firehose ?? {}),
    },
    schema: {
      columns:
        partial.schema?.columns && partial.schema.columns.length > 0
          ? partial.schema.columns
          : DEFAULT_CONFIG.schema.columns,
    },
    partitioning: {
      keys:
        partial.partitioning?.keys && partial.partitioning.keys.length > 0
          ? partial.partitioning.keys
          : DEFAULT_CONFIG.partitioning.keys,
    },
    athena: {
      ...DEFAULT_CONFIG.athena,
      ...(partial.athena ?? {}),
    },
    resource_names: {
      ...DEFAULT_CONFIG.resource_names,
      ...(partial.resource_names ?? {}),
    },
    // 도메인 목록 병합: 사용자가 지정했으면 그대로 사용, 없으면 기본값
    // 왜 배열을 통째로 대체하나?
    // - 도메인 목록은 부분 병합이 의미가 없습니다 (이름이 같은 도메인을 합쳐야 하는지 등 규칙이 모호).
    // - 사용자가 domains를 지정했으면 그것이 전체 목록이라고 간주합니다.
    domains:
      partial.domains && partial.domains.length > 0
        ? partial.domains
        : DEFAULT_CONFIG.domains,
    connections: partial.connections ?? DEFAULT_CONFIG.connections,
    alerts: {
      webhook_url: partial.alerts?.webhook_url ?? DEFAULT_CONFIG.alerts.webhook_url,
      rules:
        partial.alerts?.rules && partial.alerts.rules.length > 0
          ? partial.alerts.rules
          : DEFAULT_CONFIG.alerts.rules,
    },
  };
}

// =============================================================
// 설정 경로 내보내기 (테스트 등에서 활용)
// =============================================================
export { CONFIG_DIR, CONFIG_PATH };

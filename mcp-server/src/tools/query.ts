/**
 * athena-query MCP 도구
 *
 * 이 파일의 역할:
 * - "athena-query"라는 MCP 도구를 등록합니다.
 * - Claude Code가 "오늘 에러 로그 보여줘"라고 하면, Claude가 SQL을 생성하고 이 도구를 호출합니다.
 * - Athena에 SQL을 보내고, 결과를 받아서 텍스트로 반환합니다.
 *
 * Athena 쿼리 실행 흐름:
 * 1. StartQueryExecution: Athena에 SQL을 제출합니다 (비동기 — 즉시 반환)
 * 2. GetQueryExecution: 쿼리 상태를 폴링합니다 (QUEUED → RUNNING → SUCCEEDED/FAILED)
 * 3. GetQueryResults: 성공하면 결과를 가져옵니다
 *
 * 왜 비동기 폴링이 필요한가?
 * - Athena는 대규모 데이터를 스캔하므로 실행에 수 초~수 분이 걸립니다.
 * - 동기 API가 없어서, 제출 후 완료될 때까지 상태를 반복 확인해야 합니다.
 *
 * 비용 추적:
 * - 모듈 레벨 변수로 세션 내 모든 쿼리의 비용을 누적합니다.
 * - T-006 get-cost 도구에서 이 데이터를 import하여 사용합니다.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../config.js";

// =============================================================
// AWS SDK v3: Athena 클라이언트
// =============================================================
// Athena는 서버리스 SQL 쿼리 서비스입니다.
// S3에 저장된 데이터를 직접 SQL로 분석할 수 있습니다.
// 필요한 Command만 import하여 번들 크기를 최소화합니다.

import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
} from "@aws-sdk/client-athena";

// Glue 데이터베이스 이름은 config.resource_names.database에서 로드됩니다.

// =============================================================
// 쿼리 비용 추적용 타입과 모듈 레벨 변수
// =============================================================
// 왜 모듈 레벨 변수인가?
// - MCP 서버는 프로세스가 살아 있는 동안 상태를 유지합니다.
// - 세션(=프로세스 생명주기) 동안 실행된 쿼리의 비용을 누적 추적합니다.
// - 프로세스가 종료되면 초기화됩니다 (영구 저장은 불필요).

/**
 * 개별 쿼리 기록 타입
 * - sql: 실행한 SQL 쿼리문
 * - scannedBytes: Athena가 스캔한 데이터 크기 (bytes)
 * - cost: 예상 비용 (USD, $5/TB 기준)
 * - timestamp: 쿼리 실행 시각 (ISO 8601 문자열)
 */
export interface QueryRecord {
  sql: string;
  scannedBytes: number;
  cost: number;
  timestamp: string;
}

/**
 * 세션 내 쿼리 히스토리
 * T-006 get-cost 도구에서 이 배열을 import하여 비용 요약을 제공합니다.
 */
export const queryHistory: QueryRecord[] = [];

// =============================================================
// 쿼리 결과 캐시
// =============================================================
// 동일 SQL 쿼리의 반복 실행을 방지하여 Athena 비용을 절약합니다.
// SQL 문자열을 키로 사용하며, TTL(5분) 이내의 캐시만 유효합니다.

interface CacheEntry {
  result: string;       // 포매팅된 결과 텍스트
  scannedBytes: number;
  cost: number;
  cachedAt: number;     // Date.now()
}

const queryCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5분

// =============================================================
// 폴링 설정 상수
// =============================================================
// 왜 상수로 분리하나?
// - 매직 넘버(의미 없는 숫자)를 피하고, 의도를 명확히 합니다.
// - 나중에 config.yaml에서 읽도록 변경하기도 쉽습니다.

/** 폴링 간격: 1초 (밀리초 단위) */
const POLL_INTERVAL_MS = 1000;

/** 최대 대기 시간: 60초 (밀리초 단위) */
const MAX_WAIT_MS = 60000;

/** Athena 비용: $5/TB (AWS 공식 가격) */
const COST_PER_BYTE = 5 / Math.pow(1024, 4);

// =============================================================
// 입력 파라미터 스키마 (zod)
// =============================================================
// MCP SDK는 zod 스키마를 기반으로:
// 1. 입력 파라미터를 자동 검증합니다.
// 2. Claude에게 "이 도구는 이런 파라미터를 받는다"를 알려줍니다.

const sqlSchema = z
  .string()
  .describe(
    "Athena SQL query to execute. The query runs against the s3_logwatch Glue database. Example: SELECT level, count(*) FROM logs WHERE year='2026' AND month='03' AND day='28' GROUP BY level"
  );

const regionSchema = z
  .string()
  .optional()
  .describe(
    'AWS region for Athena. Defaults to config region. Override if your resources are in a different region.'
  );

// =============================================================
// 도구 등록 함수
// =============================================================

/**
 * athena-query 도구를 MCP 서버에 등록합니다.
 *
 * 이 함수는 tools/index.ts의 registerTools()에서 호출됩니다.
 * server.tool()로 도구 이름, 설명, 스키마, 핸들러를 등록합니다.
 */
export function registerQueryTool(server: McpServer): void {
  // =============================================================
  // 도구 설명을 동적으로 생성합니다.
  // config.yaml에서 domains 목록을 읽어, Claude가 SQL 생성 시
  // 적절한 WHERE domain='...' 조건을 포함하도록 유도합니다.
  // =============================================================
  const config = loadConfig();

  // 도메인 이름 목록을 추출합니다 (예: "user, order, payment, auth, notification")
  const domainNames = config.domains.map((d) => d.name).join(", ");

  // 스키마 컬럼 정보를 추출합니다 (예: "timestamp (timestamp), level (string), ...")
  const columnDescriptions = config.schema.columns
    .map((c) => `${c.name} (${c.type})`)
    .join(", ");

  // 파티션 키 정보를 추출합니다 (예: "domain (string), year (string), ...")
  // domain은 Glue partition projection으로 자동 생성되는 파티션 컬럼입니다.
  const partitionDescriptions = ["domain (string)"]
    .concat(config.partitioning.keys.map((k) => `${k} (string)`))
    .join(", ");

  // 도구 설명: Claude가 이 정보를 참조하여 올바른 SQL을 생성합니다.
  // 테이블 스키마, 파티션 구조, 사용 가능한 도메인 목록을 포함합니다.
  const toolDescription = [
    "Execute an Athena SQL query on s3-logwatch log data.",
    "",
    `Database: ${config.resource_names.database}`,
    "Table: logs",
    "",
    `Columns: ${columnDescriptions}`,
    `Partition columns: ${partitionDescriptions}`,
    "",
    `Available domains: ${domainNames}`,
    "",
    "IMPORTANT: Always include WHERE domain='...' for efficient partition filtering.",
    `Example: SELECT * FROM logs WHERE domain='user' AND year='2026' AND month='03' LIMIT 10`,
  ].join("\n");

  server.tool(
    // 도구 이름: Claude Code가 이 이름으로 도구를 호출합니다
    "athena-query",

    // 도구 설명: config에서 읽은 도메인 목록과 스키마 정보를 포함한 동적 설명
    toolDescription,

    // 입력 파라미터 스키마
    {
      sql: sqlSchema,
      region: regionSchema,
    },

    // 핸들러 함수: 도구 호출 시 실행되는 로직
    async (args) => {
      try {
        return await executeQuery(args.sql, args.region);
      } catch (error: unknown) {
        // 예상치 못한 에러를 사용자에게 읽기 쉽게 반환합니다
        const message =
          error instanceof Error
            ? error.message
            : "알 수 없는 오류가 발생했습니다.";
        return {
          content: [
            {
              type: "text" as const,
              text: `Athena 쿼리 실행 실패: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

// =============================================================
// 쿼리 실행 메인 함수
// =============================================================

/**
 * Athena 쿼리를 실행하고 결과를 반환합니다.
 *
 * 실행 흐름:
 * 1. config.yaml에서 Athena 워크그룹, 출력 위치를 가져옵니다.
 * 2. StartQueryExecution으로 쿼리를 제출합니다.
 * 3. GetQueryExecution으로 완료까지 폴링합니다.
 * 4. 성공 시 GetQueryResults로 결과를 가져옵니다.
 * 5. 결과를 테이블 형식 텍스트로 변환하고, 비용 정보를 추가합니다.
 */
async function executeQuery(sql: string, region?: string) {
  // 0단계: 캐시 확인 (lazy cleanup 포함)
  // 만료된 엔트리를 정리한 후, 캐시 히트 여부를 확인합니다.
  const now = Date.now();
  for (const [key, entry] of queryCache) {
    if (now - entry.cachedAt > CACHE_TTL_MS) {
      queryCache.delete(key);
    }
  }

  const cached = queryCache.get(sql);
  if (cached && now - cached.cachedAt <= CACHE_TTL_MS) {
    // 캐시 히트: Athena 호출을 스킵합니다.
    // 비용이 $0이므로 queryHistory에는 추가하지 않습니다.
    console.error(`[athena-query] 캐시 히트 (cached ${Math.round((now - cached.cachedAt) / 1000)}초 전)`);
    const scannedMB = (cached.scannedBytes / (1024 * 1024)).toFixed(2);
    const costStr = cached.cost.toFixed(6);
    const resultText = [
      cached.result,
      "",
      `Scanned: ${scannedMB} MB  Cost: $${costStr}  (cached)`,
    ].join("\n");

    return {
      content: [
        {
          type: "text" as const,
          text: resultText,
        },
      ],
    };
  }

  // 1단계: 설정 로드
  const config = loadConfig();
  const resolvedRegion = region ?? config.region;

  // Athena 클라이언트 생성
  // 왜 매번 생성하나? region이 호출마다 다를 수 있으므로 재사용이 어렵습니다.
  const athena = new AthenaClient({ region: resolvedRegion });

  // 2단계: 쿼리 제출 (StartQueryExecution)
  // Athena에 SQL을 보내면 QueryExecutionId를 받습니다.
  // 이 ID로 상태를 조회하고 결과를 가져옵니다.
  console.error(`[athena-query] 쿼리 제출 중... region=${resolvedRegion}`);

  const startResult = await athena.send(
    new StartQueryExecutionCommand({
      // 실행할 SQL 쿼리문
      QueryString: sql,
      // 워크그룹: 쿼리 실행 환경 (init-infra에서 생성한 것)
      WorkGroup: config.athena.workgroup,
      // 쿼리 컨텍스트: 어떤 Glue 데이터베이스를 사용할지 지정
      QueryExecutionContext: {
        Database: config.resource_names.database,
      },
      // 결과 저장 위치: 쿼리 결과가 CSV로 저장되는 S3 경로
      ResultConfiguration: {
        OutputLocation: config.athena.output_location,
      },
    })
  );

  const queryExecutionId = startResult.QueryExecutionId;
  if (!queryExecutionId) {
    return {
      content: [
        {
          type: "text" as const,
          text: "Athena가 QueryExecutionId를 반환하지 않았습니다. AWS 설정을 확인하세요.",
        },
      ],
      isError: true,
    };
  }

  console.error(
    `[athena-query] 쿼리 제출 완료. QueryExecutionId=${queryExecutionId}`
  );

  // 3단계: 쿼리 상태 폴링 (GetQueryExecution)
  // QUEUED → RUNNING → SUCCEEDED/FAILED/CANCELLED 순으로 상태가 변합니다.
  // 1초 간격으로 확인하며, 최대 60초까지 기다립니다.
  const pollResult = await pollQueryExecution(athena, queryExecutionId);

  // 쿼리 실패 또는 타임아웃 처리
  if (pollResult.status === "FAILED") {
    // StateChangeReason에 실패 원인이 담겨 있습니다 (예: SQL 문법 오류)
    return {
      content: [
        {
          type: "text" as const,
          text: `쿼리 실패: ${pollResult.reason ?? "알 수 없는 오류"}`,
        },
      ],
      isError: true,
    };
  }

  if (pollResult.status === "CANCELLED") {
    return {
      content: [
        {
          type: "text" as const,
          text: "쿼리가 취소되었습니다.",
        },
      ],
      isError: true,
    };
  }

  if (pollResult.status === "TIMEOUT") {
    return {
      content: [
        {
          type: "text" as const,
          text: `쿼리 타임아웃: ${MAX_WAIT_MS / 1000}초 내에 완료되지 않았습니다. QueryExecutionId=${queryExecutionId}`,
        },
      ],
      isError: true,
    };
  }

  // 4단계: 결과 가져오기 (GetQueryResults)
  console.error(`[athena-query] 쿼리 성공. 결과를 가져오는 중...`);

  const resultsResponse = await athena.send(
    new GetQueryResultsCommand({
      QueryExecutionId: queryExecutionId,
    })
  );

  // 5단계: 결과를 테이블 형식 텍스트로 변환
  const rows = resultsResponse.ResultSet?.Rows ?? [];
  const tableText = formatResultsAsTable(rows);

  // 6단계: 스캔량 + 비용 계산
  // DataScannedInBytes: Athena가 실제로 스캔한 데이터 크기
  // Athena 비용은 스캔한 데이터 양에 비례합니다 ($5/TB)
  const scannedBytes = pollResult.scannedBytes ?? 0;
  const cost = scannedBytes * COST_PER_BYTE;
  const scannedMB = (scannedBytes / (1024 * 1024)).toFixed(2);
  const costStr = cost.toFixed(6);

  // 7단계: 쿼리 히스토리에 기록 (세션 내 비용 누적 추적)
  queryHistory.push({
    sql,
    scannedBytes,
    cost,
    timestamp: new Date().toISOString(),
  });

  // 7.5단계: 결과를 캐시에 저장
  queryCache.set(sql, {
    result: tableText,
    scannedBytes,
    cost,
    cachedAt: Date.now(),
  });

  // 8단계: 최종 응답 구성
  const resultText = [
    tableText,
    "", // 빈 줄로 구분
    `Scanned: ${scannedMB} MB  Cost: $${costStr}  (fresh)`,
  ].join("\n");

  return {
    content: [
      {
        type: "text" as const,
        text: resultText,
      },
    ],
  };
}

// =============================================================
// 폴링 함수
// =============================================================

/**
 * 폴링 결과 타입
 * - status: 쿼리의 최종 상태
 * - reason: 실패 시 원인 메시지
 * - scannedBytes: 스캔한 데이터 크기 (bytes)
 */
interface PollResult {
  status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMEOUT";
  reason?: string;
  scannedBytes?: number;
}

/**
 * Athena 쿼리가 완료될 때까지 상태를 폴링합니다.
 *
 * 왜 폴링이 필요한가?
 * - Athena는 비동기 실행만 지원합니다.
 * - 쿼리를 제출하면 즉시 반환되고, 완료 여부는 별도로 확인해야 합니다.
 * - 웹소켓이나 콜백 알림이 없으므로 주기적으로 상태를 확인합니다.
 *
 * @param athena - Athena 클라이언트
 * @param queryExecutionId - 쿼리 실행 ID
 * @returns 쿼리 최종 상태와 스캔 정보
 */
async function pollQueryExecution(
  athena: AthenaClient,
  queryExecutionId: string
): Promise<PollResult> {
  const startTime = Date.now();

  while (Date.now() - startTime < MAX_WAIT_MS) {
    // 상태 조회
    const response = await athena.send(
      new GetQueryExecutionCommand({
        QueryExecutionId: queryExecutionId,
      })
    );

    const state = response.QueryExecution?.Status?.State;
    const reason = response.QueryExecution?.Status?.StateChangeReason;
    const stats = response.QueryExecution?.Statistics;

    // stderr에 현재 상태를 로깅합니다.
    // 왜 stderr인가? MCP는 stdout을 프로토콜 통신에 사용하므로,
    // 디버그 로그는 반드시 stderr로 출력해야 합니다.
    console.error(`[athena-query] 상태: ${state ?? "UNKNOWN"}`);

    // 최종 상태에 도달하면 반환
    if (state === "SUCCEEDED") {
      return {
        status: "SUCCEEDED",
        scannedBytes: Number(stats?.DataScannedInBytes ?? 0),
      };
    }

    if (state === "FAILED") {
      return {
        status: "FAILED",
        reason: reason ?? undefined,
      };
    }

    if (state === "CANCELLED") {
      return {
        status: "CANCELLED",
      };
    }

    // QUEUED 또는 RUNNING 상태면 대기 후 재확인
    // Promise 기반 sleep: setTimeout을 Promise로 감싸서 await할 수 있게 합니다.
    await sleep(POLL_INTERVAL_MS);
  }

  // 타임아웃: MAX_WAIT_MS 내에 완료되지 않음
  return { status: "TIMEOUT" };
}

// =============================================================
// 결과 포맷팅 함수
// =============================================================

/**
 * Athena 결과 Rows를 텍스트 테이블로 변환합니다.
 *
 * Athena의 ResultSet.Rows 구조:
 * - 첫 번째 Row: 컬럼 헤더 (컬럼 이름들)
 * - 나머지 Rows: 실제 데이터
 * - 각 Row는 Data 배열을 가지며, 각 원소에 VarCharValue가 있습니다.
 *
 * 출력 예시:
 * level     | count
 * ----------|------
 * ERROR     | 42
 * WARN      | 128
 *
 * @param rows - Athena ResultSet의 Rows 배열
 * @returns 테이블 형식의 문자열
 */
function formatResultsAsTable(
  rows: { Data?: { VarCharValue?: string }[] }[]
): string {
  if (rows.length === 0) {
    return "(결과 없음)";
  }

  // 각 Row에서 셀 값을 추출합니다
  // VarCharValue가 없으면 빈 문자열로 대체합니다
  const tableData = rows.map(
    (row) => row.Data?.map((cell) => cell.VarCharValue ?? "") ?? []
  );

  // 헤더가 있지만 데이터 행이 없는 경우
  if (tableData.length <= 1) {
    const header = tableData[0];
    if (header) {
      return `${header.join(" | ")}\n(데이터 없음)`;
    }
    return "(결과 없음)";
  }

  // 각 컬럼의 최대 폭을 계산합니다 (정렬을 위해)
  // 왜 최대 폭을 계산하나?
  // - 컬럼 값 길이가 제각각이면 테이블이 읽기 어렵습니다.
  // - 각 컬럼을 최대 폭에 맞춰 정렬하면 깔끔하게 보입니다.
  const colCount = tableData[0].length;
  const colWidths: number[] = [];
  for (let col = 0; col < colCount; col++) {
    let maxWidth = 0;
    for (const row of tableData) {
      const cellWidth = (row[col] ?? "").length;
      if (cellWidth > maxWidth) {
        maxWidth = cellWidth;
      }
    }
    colWidths.push(maxWidth);
  }

  // 행을 포맷팅합니다
  const formatRow = (row: string[]): string =>
    row.map((cell, i) => cell.padEnd(colWidths[i])).join(" | ");

  // 헤더 + 구분선 + 데이터 행
  const header = formatRow(tableData[0]);
  const separator = colWidths.map((w) => "-".repeat(w)).join("-|-");
  const dataRows = tableData.slice(1).map(formatRow);

  return [header, separator, ...dataRows].join("\n");
}

// =============================================================
// 유틸리티
// =============================================================

/**
 * 지정된 시간(밀리초)만큼 대기하는 Promise를 반환합니다.
 *
 * 왜 이 함수가 필요한가?
 * - JavaScript의 setTimeout은 콜백 기반이라 await할 수 없습니다.
 * - Promise로 감싸면 async/await 패턴에서 깔끔하게 사용할 수 있습니다.
 * - 예: await sleep(1000); // 1초 대기
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

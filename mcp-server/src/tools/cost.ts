/**
 * get-cost MCP 도구
 *
 * 이 파일의 역할:
 * - "get-cost"라는 MCP 도구를 등록합니다.
 * - Claude Code에게 "쿼리 비용 얼마야?"라고 물으면 이 도구가 호출됩니다.
 * - 세션(=프로세스 생명주기) 동안 실행된 Athena 쿼리의 누적 비용을 보여줍니다.
 *
 * 왜 세션 기반인가?
 * - MCP 서버는 프로세스가 살아 있는 동안만 상태를 유지합니다.
 * - 서버(프로세스)가 재시작되면 queryHistory가 초기화되므로 비용도 리셋됩니다.
 * - 영구 저장은 불필요합니다 — AWS 콘솔에서 실제 청구 내역을 확인할 수 있기 때문입니다.
 *
 * 비용 계산 기준:
 * - Athena 과금: $5/TB (스캔한 데이터량 기준)
 * - 최소 과금 단위: 10MB (AWS 정책이지만, 여기서는 실제 스캔량을 그대로 표시합니다)
 * - "사용 안 하면 비용 $0" 컨셉의 투명성을 위한 도구입니다.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { queryHistory } from "./query.js";

// =============================================================
// 도구 등록 함수
// =============================================================

/**
 * get-cost 도구를 MCP 서버에 등록합니다.
 *
 * 다른 도구(config, init, connect, query)와 동일한 패턴:
 * 1. server.tool()로 도구를 등록
 * 2. 핸들러에서 비즈니스 로직 실행
 * 3. 결과를 MCP CallToolResult 형태로 반환
 *
 * 왜 입력 파라미터가 빈 객체인가?
 * - 이 도구는 세션 내 누적 데이터를 조회만 하므로 입력이 필요 없습니다.
 * - MCP SDK의 server.tool()은 스키마로 빈 객체({})를 받으면 "파라미터 없음"으로 처리합니다.
 */
export function registerCostTool(server: McpServer): void {
  server.tool(
    // 도구 이름: Claude Code가 이 이름으로 도구를 호출합니다
    "get-cost",

    // 도구 설명: Claude가 "비용 얼마야?" 같은 요청을 이 도구에 매핑하는 데 사용
    "Show the cumulative Athena query cost for this session. Returns per-query breakdown (SQL, scanned bytes, cost) and total estimated cost based on $5/TB pricing. No queries means $0 cost.",

    // 입력 파라미터 스키마: 빈 객체 (파라미터 없음)
    {},

    // 핸들러 함수: 도구 호출 시 실행되는 로직
    async () => {
      const text = buildCostReport();
      return {
        content: [
          {
            type: "text" as const,
            text,
          },
        ],
      };
    }
  );
}

// =============================================================
// 비용 리포트 생성 함수
// =============================================================

/**
 * 세션 내 쿼리 비용 리포트를 텍스트로 생성합니다.
 *
 * 왜 별도 함수로 분리하나?
 * - 핸들러 함수는 간결하게 유지하고, 포맷팅 로직은 테스트하기 쉽게 분리합니다.
 * - SOLID 원칙의 단일 책임: 핸들러는 MCP 응답 구조, 이 함수는 텍스트 포맷팅을 담당합니다.
 *
 * @returns 비용 리포트 텍스트 문자열
 */
function buildCostReport(): string {
  // 쿼리가 없는 경우: 간단한 안내 메시지를 반환합니다
  if (queryHistory.length === 0) {
    return "이번 세션에서 실행한 쿼리가 없습니다.";
  }

  // --- 합계 계산 ---
  // reduce를 사용하여 모든 쿼리의 스캔량과 비용을 합산합니다.
  // 왜 reduce인가? 배열의 모든 요소를 하나의 값으로 축약하는 데 가장 적합한 메서드입니다.
  const totalScannedBytes = queryHistory.reduce(
    (sum, record) => sum + record.scannedBytes,
    0
  );
  const totalCost = queryHistory.reduce(
    (sum, record) => sum + record.cost,
    0
  );

  // --- 단위 변환 ---
  // 스캔량: bytes -> MB (사람이 읽기 쉬운 단위)
  // 비용: $ 소수점 6자리 (Athena 비용이 매우 작을 수 있으므로)
  const totalScannedMB = (totalScannedBytes / (1024 * 1024)).toFixed(2);
  const totalCostStr = totalCost.toFixed(6);

  // --- 쿼리별 내역 테이블 생성 ---
  // 각 쿼리의 번호, 시간, SQL 앞 50자, 스캔량, 비용을 테이블로 보여줍니다.
  // 왜 SQL을 50자로 자르나? 긴 SQL은 테이블을 읽기 어렵게 만들기 때문입니다.
  const tableHeader = "| #  | 시간                | SQL (앞 50자)                                      | 스캔량      | 비용        |";
  const tableSeparator = "|----|---------------------|----------------------------------------------------|-------------|-------------|";

  const tableRows = queryHistory.map((record, index) => {
    // 번호: 1부터 시작, 2자리로 맞춤
    const num = String(index + 1).padStart(2, " ");

    // 시간: ISO 8601에서 날짜와 시간 부분만 추출 (YYYY-MM-DD HH:mm:ss 형태가 아닌, 공간 절약을 위해 HH:mm:ss만)
    // 왜 substring으로 자르나? ISO 8601 형식은 "2026-03-28T14:30:00.000Z"이므로,
    // 앞 19자를 잘라서 "2026-03-28T14:30:00" 형태로 만듭니다.
    const time = record.timestamp.substring(0, 19);

    // SQL: 앞 50자만 표시하고, 50자를 초과하면 "..."을 붙입니다
    const sqlPreview =
      record.sql.length > 50
        ? record.sql.substring(0, 50) + "..."
        : record.sql;
    // 테이블 정렬을 위해 50자 폭으로 패딩합니다
    // 왜 53자인가? 50자 + "..." 3자 = 최대 53자
    const sqlPadded = sqlPreview.padEnd(50, " ");

    // 스캔량: MB 단위, 소수점 2자리
    const scannedMB = (record.scannedBytes / (1024 * 1024)).toFixed(2);
    const scannedStr = `${scannedMB} MB`.padStart(11, " ");

    // 비용: $ 단위, 소수점 6자리
    const costStr = `$${record.cost.toFixed(6)}`.padStart(11, " ");

    return `| ${num} | ${time} | ${sqlPadded} | ${scannedStr} | ${costStr} |`;
  });

  // --- 최종 리포트 조합 ---
  const lines = [
    "=== Athena 쿼리 비용 요약 ===",
    "",
    `총 쿼리 수: ${queryHistory.length}건`,
    `총 스캔량:  ${totalScannedMB} MB`,
    `총 예상 비용: $${totalCostStr}`,
    "",
    "--- 쿼리별 내역 ---",
    "",
    tableHeader,
    tableSeparator,
    ...tableRows,
    "",
    "※ Athena 과금 기준: $5/TB (스캔한 데이터량 기준)",
    "※ 위 비용은 예상치이며, 실제 청구 금액은 AWS 콘솔에서 확인하세요.",
  ];

  return lines.join("\n");
}

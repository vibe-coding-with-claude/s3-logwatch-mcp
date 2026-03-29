/**
 * tools/index.ts - 도구 등록 모듈
 *
 * 이 파일에서 모든 MCP 도구를 한곳에서 등록합니다.
 * 새로운 도구를 추가할 때마다 여기에 import하고 registerTools()에서 등록합니다.
 *
 * 현재는 빈 상태이며, 다음 태스크들에서 도구가 추가됩니다:
 * - init-infra: AWS 리소스 초기화
 * - connect-log-group: CloudWatch Log Group 연결
 * - athena-query: Athena 쿼리 실행
 * - get-cost: 쿼리 비용 조회
 * - update-config: 설정 파일 관리
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerConfigTool } from "./config.js";
import { registerInitTool } from "./init.js";
import { registerConnectTool } from "./connect.js";
import { registerQueryTool } from "./query.js";
import { registerCostTool } from "./cost.js";
import { registerDestroyTool } from "./destroy.js";
import { registerDisconnectTool } from "./disconnect.js";
import { registerAlertTool } from "./alert.js";
import { registerCheckAlertTool } from "./check-alert.js";

/**
 * 모든 도구를 MCP Server에 등록하는 함수
 * src/index.ts에서 호출합니다.
 *
 * 새로운 도구를 추가할 때는:
 * 1. src/tools/새도구.ts 파일에서 register 함수를 만듭니다
 * 2. 여기에 import하고 아래에서 호출합니다
 */
export function registerTools(server: McpServer): void {
  // T-002: 설정 파일 읽기/수정 도구
  registerConfigTool(server);

  // T-003: AWS 인프라 초기화 도구
  registerInitTool(server);

  // T-004: CloudWatch Log Group 연결 도구
  registerConnectTool(server);

  // T-005: Athena 쿼리 실행 도구
  registerQueryTool(server);

  // T-006: 쿼리 비용 조회 도구
  registerCostTool(server);

  // T-018: AWS 인프라 삭제 도구
  registerDestroyTool(server);

  // T-019: Log Group 연결 해제 도구
  registerDisconnectTool(server);

  // T-025: 알림 설정 및 체크 도구
  registerAlertTool(server);
  registerCheckAlertTool(server);
}

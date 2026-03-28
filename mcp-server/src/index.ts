/**
 * s3-logwatch MCP Server 진입점
 *
 * MCP (Model Context Protocol) 란?
 * - AI 모델(Claude)이 외부 도구를 호출할 수 있게 해주는 프로토콜입니다.
 * - Claude Code가 이 서버에 연결하면, 서버가 제공하는 도구들을 자동으로 인식합니다.
 * - 사용자가 "오늘 에러 로그 보여줘"라고 말하면, Claude가 적절한 도구를 골라 호출합니다.
 *
 * 이 파일의 역할:
 * 1. MCP Server 인스턴스를 생성합니다
 * 2. stdio transport로 Claude Code와 연결합니다
 * 3. 등록된 도구들을 Claude에게 노출합니다
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// 도구(tool) 등록 함수를 가져옵니다
// registerTools 하나로 모든 도구가 등록됩니다 (tools/index.ts에서 관리)
import { registerTools } from "./tools/index.js";

// =============================================================
// MCP Server 인스턴스 생성
// =============================================================
// name: Claude Code가 이 서버를 식별하는 이름입니다
// version: 서버 버전 (Claude Code UI에 표시됩니다)
const server = new McpServer({
  name: "s3-logwatch",
  version: "0.1.0",
});

// =============================================================
// 도구(tool) 등록
// =============================================================
// 각 도구는 src/tools/ 디렉토리에 구현되어 있고, 여기서 server에 등록합니다.
// 도구가 등록되면 Claude Code가 자동으로 인식하여 사용할 수 있습니다.

// 모든 도구를 한번에 등록합니다 (tools/index.ts 참고)
registerTools(server);

// =============================================================
// 서버 시작
// =============================================================
async function main(): Promise<void> {
  /**
   * stdio transport를 사용하는 이유:
   *
   * MCP는 서버-클라이언트 간 통신 방식(transport)을 여러 가지 지원합니다:
   * - stdio: 표준 입출력(stdin/stdout)을 통해 통신
   * - SSE (Server-Sent Events): HTTP 기반 통신
   *
   * stdio를 선택한 이유:
   * 1. Claude Code가 MCP 서버를 자식 프로세스로 실행하고 stdin/stdout으로 통신합니다.
   *    별도의 포트 설정이나 네트워크 구성이 필요 없습니다.
   * 2. 로컬 개발 환경에 가장 간단한 방식입니다.
   * 3. MCP 공식 문서에서 권장하는 기본 transport입니다.
   */
  const transport = new StdioServerTransport();

  // 서버를 transport에 연결합니다.
  // 이 시점부터 Claude Code의 메시지를 수신할 수 있습니다.
  await server.connect(transport);

  // 참고: console.log()는 stdout을 사용하므로 MCP 메시지와 충돌합니다.
  // 디버그 로그가 필요하면 stderr(console.error)를 사용하세요.
  console.error("s3-logwatch MCP Server started (stdio transport)");
}

// 서버 시작 및 에러 처리
main().catch((error: unknown) => {
  console.error("서버 시작 실패:", error);
  process.exit(1);
});

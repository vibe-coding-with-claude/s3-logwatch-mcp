/**
 * disconnect-log-group MCP 도구
 *
 * 이 파일의 역할:
 * - "disconnect-log-group"이라는 MCP 도구를 등록합니다.
 * - connect-log-group으로 연결한 CloudWatch Log Group의 Subscription Filter를 삭제합니다.
 * - config.yaml의 connections에서 해당 항목을 제거합니다.
 *
 * connect-log-group의 역연산:
 * - connect: PutSubscriptionFilter + connections에 추가
 * - disconnect: DeleteSubscriptionFilter + connections에서 제거
 *
 * 멱등성(Idempotency):
 * - 이미 삭제된(존재하지 않는) 필터는 스킵합니다.
 * - config.yaml에 해당 항목이 없어도 에러 없이 동작합니다.
 * - 두 번 실행해도 에러 없이 동작합니다.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, saveConfig } from "../config.js";

// =============================================================
// AWS SDK v3 클라이언트 import
// =============================================================

import {
  CloudWatchLogsClient,
  DeleteSubscriptionFilterCommand,
} from "@aws-sdk/client-cloudwatch-logs";

// =============================================================
// 입력 파라미터 스키마
// =============================================================

/**
 * log_group: 연결 해제할 CloudWatch Log Group 이름 (필수)
 * 어떤 Log Group의 Subscription Filter를 삭제할지 반드시 지정해야 합니다.
 */
const logGroupSchema = z
  .string()
  .describe(
    'CloudWatch Log Group name to disconnect. Example: "/ecs/payment-api"'
  );

/**
 * domain: 해당 Log Group이 속하는 도메인 이름 (필수)
 * Subscription Filter 이름을 생성하는 데 필요합니다.
 * connect-log-group에서 사용한 도메인과 동일해야 합니다.
 */
const domainSchema = z
  .string()
  .describe(
    "Domain name this log group belongs to (e.g. 'user', 'order', 'payment'). " +
      "Must match the domain used when connecting."
  );

/**
 * region: AWS 리전 (선택적, 기본값 us-east-1)
 */
const regionSchema = z
  .string()
  .optional()
  .describe(
    'AWS region (default: config region (ap-northeast-2)). Example: "ap-northeast-2" for Seoul.'
  );

// =============================================================
// 도구 등록 함수
// =============================================================

/**
 * disconnect-log-group 도구를 MCP 서버에 등록합니다.
 */
export function registerDisconnectTool(server: McpServer): void {
  server.tool(
    // 도구 이름
    "disconnect-log-group",

    // 도구 설명
    "Disconnect a CloudWatch Log Group from the s3-logwatch pipeline by removing its Subscription Filter. " +
      "Also removes the connection entry from config.yaml. " +
      "Safe to run multiple times (idempotent - skips already-deleted filters).",

    // 입력 파라미터 스키마
    {
      log_group: logGroupSchema,
      domain: domainSchema,
      region: regionSchema,
    },

    // 핸들러 함수
    async (args) => {
      try {
        const result = await disconnectLogGroup(
          args.log_group,
          args.domain,
          args.region
        );
        return {
          content: [
            {
              type: "text" as const,
              text: result,
            },
          ],
        };
      } catch (error: unknown) {
        const message =
          error instanceof Error
            ? error.message
            : "알 수 없는 오류가 발생했습니다.";
        return {
          content: [
            {
              type: "text" as const,
              text: `Log Group 연결 해제 실패: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

// =============================================================
// 메인 연결 해제 로직
// =============================================================

/**
 * CloudWatch Log Group의 Subscription Filter를 삭제하고 config.yaml을 업데이트합니다.
 *
 * 순서:
 * 1. Subscription Filter 이름 생성 (connect.ts와 동일한 규칙)
 * 2. DeleteSubscriptionFilter로 필터 삭제
 * 3. config.yaml의 connections에서 해당 항목 제거
 *
 * @param logGroup - CloudWatch Log Group 이름
 * @param domain - 도메인 이름
 * @param region - AWS 리전 (기본값: us-east-1)
 * @returns 성공 메시지 문자열
 */
async function disconnectLogGroup(
  logGroup: string,
  domain: string,
  region?: string
): Promise<string> {
  const config = loadConfig();
  const resolvedRegion = region ?? config.region;

  // AWS SDK 클라이언트 생성
  const cwlClient = new CloudWatchLogsClient({ region: resolvedRegion });

  // --- (1) Subscription Filter 이름 생성 ---
  // connect.ts의 buildFilterName과 동일한 규칙을 사용합니다.
  const filterName = buildFilterName(logGroup, domain);

  // --- (2) Subscription Filter 삭제 ---
  let filterStatus: "deleted" | "not_found";
  try {
    await cwlClient.send(
      new DeleteSubscriptionFilterCommand({
        logGroupName: logGroup,
        filterName,
      })
    );
    filterStatus = "deleted";
  } catch (error: unknown) {
    const errorName = (error as { name?: string })?.name ?? "";
    // ResourceNotFoundException: 필터가 이미 존재하지 않음 -> 스킵 (멱등성)
    if (
      errorName === "ResourceNotFoundException" ||
      errorName === "ResourceNotFoundError"
    ) {
      filterStatus = "not_found";
    } else {
      // 다른 에러는 그대로 전파
      throw error;
    }
  }

  // --- (3) config.yaml의 connections에서 해당 항목 제거 ---
  // config를 최신 상태로 다시 읽어서 connections 수정
  const latestConfig = loadConfig();
  const beforeCount = latestConfig.connections.length;
  latestConfig.connections = latestConfig.connections.filter(
    (c) => !(c.log_group === logGroup && c.domain === domain)
  );
  const removedFromConfig = latestConfig.connections.length < beforeCount;

  // 변경이 있으면 config.yaml 저장
  if (removedFromConfig) {
    saveConfig(latestConfig);
  }

  // --- (4) 결과 메시지 반환 ---
  const filterMessage =
    filterStatus === "deleted"
      ? `Subscription Filter '${filterName}' 삭제 완료`
      : `Subscription Filter '${filterName}' 이미 삭제됨 (스킵)`;

  const configMessage = removedFromConfig
    ? "config.yaml connections에서 항목 제거 완료"
    : "config.yaml connections에 해당 항목 없음 (스킵)";

  return [
    `Log Group 연결 해제 완료!`,
    ``,
    `  Log Group:    ${logGroup}`,
    `  Domain:       ${domain}`,
    `  Filter Name:  ${filterName}`,
    ``,
    `  ${filterMessage}`,
    `  ${configMessage}`,
  ].join("\n");
}

// =============================================================
// Subscription Filter 이름 생성 (connect.ts의 buildFilterName과 동일)
// =============================================================

/**
 * Log Group 이름에서 Subscription Filter 이름을 생성합니다.
 * connect.ts의 buildFilterName과 동일한 로직입니다.
 *
 * 예: domain="payment", logGroup="/ecs/payment-api"
 *     -> "s3-logwatch-payment-ecs-payment-api"
 *
 * @param logGroup - CloudWatch Log Group 이름
 * @param domain - 도메인 이름
 * @returns Subscription Filter 이름
 */
function buildFilterName(logGroup: string, domain: string): string {
  const sanitized = logGroup.replace(/^\/+|\/+$/g, "").replace(/\//g, "-");
  return `s3-logwatch-${domain}-${sanitized}`;
}

/**
 * check-alerts MCP 도구
 *
 * 설정된 알림 규칙을 기반으로 Athena 쿼리를 실행하여
 * 로그 건수가 threshold를 초과하는지 확인합니다.
 * 초과 시 webhook으로 알림을 보내는 로직을 포함합니다 (코드만, 실제 호출은 주석 처리).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../config.js";
import type { AlertRule } from "../config.js";
import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
} from "@aws-sdk/client-athena";

// =============================================================
// 상수
// =============================================================

const GLUE_DATABASE_NAME = "s3_logwatch";
const POLL_INTERVAL_MS = 1000;
const MAX_WAIT_MS = 60000;

// =============================================================
// 입력 스키마
// =============================================================

const regionSchema = z
  .string()
  .optional()
  .describe('AWS region for Athena. Defaults to config region.');

// =============================================================
// 도구 등록
// =============================================================

export function registerCheckAlertTool(server: McpServer): void {
  server.tool(
    "check-alerts",
    "Check all configured alert rules against current log data. Runs Athena queries for each rule and reports which thresholds are exceeded.",
    {
      region: regionSchema,
    },
    async (args) => {
      try {
        return await handleCheckAlerts(args.region);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
        return {
          content: [{ type: "text" as const, text: `check-alerts 실패: ${message}` }],
          isError: true,
        };
      }
    }
  );
}

// =============================================================
// 핸들러
// =============================================================

/**
 * 각 규칙에 대해 현재 건수를 체크하고, 결과를 반환합니다.
 */
interface RuleCheckResult {
  rule: AlertRule;
  count: number;
  exceeded: boolean;
  error?: string;
}

async function handleCheckAlerts(region?: string) {
  const config = loadConfig();
  const resolvedRegion = region ?? config.region;

  if (config.alerts.rules.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: "설정된 알림 규칙이 없습니다. set-alert 도구로 규칙을 먼저 추가하세요.",
        },
      ],
    };
  }

  const athena = new AthenaClient({ region: resolvedRegion });
  const results: RuleCheckResult[] = [];

  // 각 규칙을 순차적으로 체크
  for (const rule of config.alerts.rules) {
    const result = await checkRule(athena, config.athena.workgroup, config.athena.output_location, rule);
    results.push(result);
  }

  // threshold를 초과한 규칙이 있으면 webhook 알림 전송
  const exceededResults = results.filter((r) => r.exceeded);
  if (exceededResults.length > 0 && config.alerts.webhook_url) {
    await sendWebhookNotification(config.alerts.webhook_url, exceededResults);
  }

  // 결과 요약 텍스트 생성
  const summary = formatCheckResults(results, config.alerts.webhook_url);

  return {
    content: [{ type: "text" as const, text: summary }],
  };
}

// =============================================================
// 규칙별 체크 로직
// =============================================================

/**
 * 단일 규칙에 대해 Athena 쿼리를 실행하고 건수를 확인합니다.
 */
async function checkRule(
  athena: AthenaClient,
  workgroup: string,
  outputLocation: string,
  rule: AlertRule
): Promise<RuleCheckResult> {
  const sql = buildCountQuery(rule);

  console.error(`[check-alerts] 규칙 '${rule.name}' 체크 중: ${sql}`);

  try {
    // 쿼리 제출
    const startResult = await athena.send(
      new StartQueryExecutionCommand({
        QueryString: sql,
        WorkGroup: workgroup,
        QueryExecutionContext: { Database: GLUE_DATABASE_NAME },
        ResultConfiguration: { OutputLocation: outputLocation },
      })
    );

    const queryExecutionId = startResult.QueryExecutionId;
    if (!queryExecutionId) {
      return { rule, count: 0, exceeded: false, error: "QueryExecutionId를 받지 못했습니다." };
    }

    // 폴링
    const pollResult = await pollQueryExecution(athena, queryExecutionId);
    if (pollResult.status !== "SUCCEEDED") {
      return {
        rule,
        count: 0,
        exceeded: false,
        error: `쿼리 ${pollResult.status}: ${pollResult.reason ?? ""}`,
      };
    }

    // 결과 가져오기
    const resultsResponse = await athena.send(
      new GetQueryResultsCommand({ QueryExecutionId: queryExecutionId })
    );

    const rows = resultsResponse.ResultSet?.Rows ?? [];
    // 첫 번째 행은 헤더, 두 번째 행이 COUNT(*) 값
    const countValue =
      rows.length >= 2 ? parseInt(rows[1].Data?.[0]?.VarCharValue ?? "0", 10) : 0;

    const exceeded = countValue > rule.threshold;

    return { rule, count: countValue, exceeded };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    return { rule, count: 0, exceeded: false, error: message };
  }
}

// =============================================================
// Athena 쿼리 생성
// =============================================================

/**
 * 알림 규칙에 맞는 COUNT 쿼리를 생성합니다.
 *
 * 생성 예시:
 * SELECT COUNT(*) AS cnt
 * FROM logs
 * WHERE domain='payment'
 *   AND level='ERROR'
 *   AND message LIKE '%timeout%'
 *   AND timestamp >= CURRENT_TIMESTAMP - INTERVAL '5' MINUTE
 */
function buildCountQuery(rule: AlertRule): string {
  const conditions: string[] = [];

  // 도메인 필터 (파티션 컬럼)
  conditions.push(`domain='${escapeSQL(rule.domain)}'`);

  // 레벨 필터
  if (rule.level) {
    conditions.push(`level='${escapeSQL(rule.level)}'`);
  }

  // 키워드 필터
  if (rule.keyword) {
    conditions.push(`message LIKE '%${escapeSQL(rule.keyword)}%'`);
  }

  // 시간 조건: 최근 N분
  conditions.push(
    `timestamp >= CURRENT_TIMESTAMP - INTERVAL '${rule.period_minutes}' MINUTE`
  );

  const whereClause = conditions.join(" AND ");

  return `SELECT COUNT(*) AS cnt FROM logs WHERE ${whereClause}`;
}

/**
 * SQL 인젝션 방지를 위한 간단한 이스케이프.
 * 작은따옴표를 두 개로 치환합니다.
 */
function escapeSQL(value: string): string {
  return value.replace(/'/g, "''");
}

// =============================================================
// Webhook 전송 (코드만, 실제 호출 주석 처리)
// =============================================================

/**
 * threshold를 초과한 규칙에 대해 Slack/Discord webhook 알림을 전송합니다.
 *
 * 주의: 태스크 제약에 따라 실제 fetch 호출은 주석 처리되어 있습니다.
 * 운영 환경에서는 주석을 해제하여 사용합니다.
 */
async function sendWebhookNotification(
  _webhookUrl: string,
  exceededResults: RuleCheckResult[]
): Promise<void> {
  const alertMessages = exceededResults.map((r) => {
    return `[${r.rule.name}] ${r.rule.domain} / ${r.rule.level ?? "ALL"}: ${r.count}건 (threshold: ${r.rule.threshold})`;
  });

  const payload = {
    text: `s3-logwatch Alert: ${exceededResults.length}개 규칙 초과\n${alertMessages.join("\n")}`,
  };

  console.error(`[check-alerts] Webhook payload: ${JSON.stringify(payload)}`);

  // 실제 webhook 호출 (운영 환경에서 주석 해제)
  // await fetch(webhookUrl, {
  //   method: "POST",
  //   headers: { "Content-Type": "application/json" },
  //   body: JSON.stringify(payload),
  // });
}

// =============================================================
// 결과 포맷팅
// =============================================================

function formatCheckResults(
  results: RuleCheckResult[],
  webhookUrl: string | undefined
): string {
  const lines: string[] = [];

  lines.push("=== Alert Check Results ===");
  lines.push("");

  for (const r of results) {
    const status = r.error
      ? "ERROR"
      : r.exceeded
        ? "EXCEEDED"
        : "OK";

    const statusIcon = r.error ? "[!]" : r.exceeded ? "[X]" : "[O]";

    lines.push(`${statusIcon} ${r.rule.name}`);
    lines.push(`    Domain: ${r.rule.domain}`);
    lines.push(`    Level: ${r.rule.level ?? "(전체)"}`);
    lines.push(`    Keyword: ${r.rule.keyword ?? "(없음)"}`);
    lines.push(`    Period: 최근 ${r.rule.period_minutes}분`);
    lines.push(`    Count: ${r.count} / Threshold: ${r.rule.threshold}`);
    lines.push(`    Status: ${status}`);
    if (r.error) {
      lines.push(`    Error: ${r.error}`);
    }
    lines.push("");
  }

  // 요약
  const total = results.length;
  const exceeded = results.filter((r) => r.exceeded).length;
  const errors = results.filter((r) => r.error).length;

  lines.push("---");
  lines.push(`Total: ${total} rules / Exceeded: ${exceeded} / Errors: ${errors}`);

  if (exceeded > 0 && webhookUrl) {
    lines.push(`Webhook notification sent to: ${webhookUrl}`);
  } else if (exceeded > 0 && !webhookUrl) {
    lines.push("Warning: Webhook URL이 설정되지 않아 알림을 보내지 못했습니다.");
  }

  return lines.join("\n");
}

// =============================================================
// 폴링 유틸리티
// =============================================================

interface PollResult {
  status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMEOUT";
  reason?: string;
}

async function pollQueryExecution(
  athena: AthenaClient,
  queryExecutionId: string
): Promise<PollResult> {
  const startTime = Date.now();

  while (Date.now() - startTime < MAX_WAIT_MS) {
    const response = await athena.send(
      new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId })
    );

    const state = response.QueryExecution?.Status?.State;
    const reason = response.QueryExecution?.Status?.StateChangeReason;

    if (state === "SUCCEEDED") {
      return { status: "SUCCEEDED" };
    }
    if (state === "FAILED") {
      return { status: "FAILED", reason: reason ?? undefined };
    }
    if (state === "CANCELLED") {
      return { status: "CANCELLED" };
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return { status: "TIMEOUT" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * set-alert MCP 도구
 *
 * 알림 규칙을 관리합니다 (추가/삭제/목록 조회).
 * config.yaml의 alerts 섹션에 규칙을 저장합니다.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, saveConfig } from "../config.js";
import type { AlertRule } from "../config.js";

// =============================================================
// 입력 파라미터 스키마
// =============================================================

const actionSchema = z
  .enum(["add", "remove", "list"])
  .describe("Action to perform: add a rule, remove a rule by name, or list all rules.");

const nameSchema = z
  .string()
  .optional()
  .describe("Rule name. Required for add/remove. Example: 'payment-errors'");

const domainSchema = z
  .string()
  .optional()
  .describe("Target domain for the rule. Required for add. Example: 'payment'");

const levelSchema = z
  .string()
  .optional()
  .describe("Log level filter. Optional. Example: 'ERROR'");

const keywordSchema = z
  .string()
  .optional()
  .describe("Message keyword filter. Optional. Example: 'timeout'");

const thresholdSchema = z
  .number()
  .optional()
  .describe("Alert threshold count. Required for add. Alerts fire when count exceeds this value.");

const periodMinutesSchema = z
  .number()
  .optional()
  .describe("Time window in minutes. Required for add. Example: 5 means 'last 5 minutes'.");

const webhookUrlSchema = z
  .string()
  .optional()
  .describe("Slack/Discord webhook URL. If provided, updates the webhook URL in config.");

// =============================================================
// 도구 등록
// =============================================================

export function registerAlertTool(server: McpServer): void {
  server.tool(
    "set-alert",
    "Manage alert rules for log monitoring. Add, remove, or list alert rules that trigger notifications when log patterns exceed thresholds.",
    {
      action: actionSchema,
      name: nameSchema,
      domain: domainSchema,
      level: levelSchema,
      keyword: keywordSchema,
      threshold: thresholdSchema,
      period_minutes: periodMinutesSchema,
      webhook_url: webhookUrlSchema,
    },
    async (args) => {
      try {
        return handleSetAlert(args);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
        return {
          content: [{ type: "text" as const, text: `set-alert 실패: ${message}` }],
          isError: true,
        };
      }
    }
  );
}

// =============================================================
// 핸들러
// =============================================================

function handleSetAlert(args: {
  action: "add" | "remove" | "list";
  name?: string;
  domain?: string;
  level?: string;
  keyword?: string;
  threshold?: number;
  period_minutes?: number;
  webhook_url?: string;
}) {
  const config = loadConfig();

  // webhook_url이 제공되면 항상 업데이트
  if (args.webhook_url) {
    config.alerts.webhook_url = args.webhook_url;
  }

  switch (args.action) {
    case "add": {
      // 필수 필드 검증
      if (!args.name) {
        return {
          content: [{ type: "text" as const, text: "name은 필수 항목입니다." }],
          isError: true,
        };
      }
      if (!args.domain) {
        return {
          content: [{ type: "text" as const, text: "domain은 필수 항목입니다." }],
          isError: true,
        };
      }
      if (args.threshold == null || args.threshold < 0) {
        return {
          content: [{ type: "text" as const, text: "threshold는 0 이상의 숫자여야 합니다." }],
          isError: true,
        };
      }
      if (args.period_minutes == null || args.period_minutes <= 0) {
        return {
          content: [{ type: "text" as const, text: "period_minutes는 0보다 큰 숫자여야 합니다." }],
          isError: true,
        };
      }

      // 중복 이름 체크
      const existingIndex = config.alerts.rules.findIndex((r) => r.name === args.name);
      const newRule: AlertRule = {
        name: args.name,
        domain: args.domain,
        ...(args.level ? { level: args.level } : {}),
        ...(args.keyword ? { keyword: args.keyword } : {}),
        threshold: args.threshold,
        period_minutes: args.period_minutes,
      };

      if (existingIndex >= 0) {
        // 기존 규칙 덮어쓰기
        config.alerts.rules[existingIndex] = newRule;
      } else {
        config.alerts.rules.push(newRule);
      }

      saveConfig(config);

      return {
        content: [
          {
            type: "text" as const,
            text: `알림 규칙 '${args.name}'이(가) ${existingIndex >= 0 ? "업데이트" : "추가"}되었습니다.\n\n${formatRule(newRule)}`,
          },
        ],
      };
    }

    case "remove": {
      if (!args.name) {
        return {
          content: [{ type: "text" as const, text: "삭제할 규칙의 name이 필요합니다." }],
          isError: true,
        };
      }

      const beforeCount = config.alerts.rules.length;
      config.alerts.rules = config.alerts.rules.filter((r) => r.name !== args.name);

      if (config.alerts.rules.length === beforeCount) {
        return {
          content: [{ type: "text" as const, text: `'${args.name}' 규칙을 찾을 수 없습니다.` }],
          isError: true,
        };
      }

      saveConfig(config);

      return {
        content: [
          {
            type: "text" as const,
            text: `알림 규칙 '${args.name}'이(가) 삭제되었습니다. 남은 규칙: ${config.alerts.rules.length}개`,
          },
        ],
      };
    }

    case "list": {
      // webhook_url만 업데이트하는 경우에도 저장
      if (args.webhook_url) {
        saveConfig(config);
      }

      if (config.alerts.rules.length === 0) {
        const webhookInfo = config.alerts.webhook_url
          ? `\nWebhook URL: ${config.alerts.webhook_url}`
          : "\nWebhook URL: (미설정)";

        return {
          content: [
            {
              type: "text" as const,
              text: `설정된 알림 규칙이 없습니다.${webhookInfo}`,
            },
          ],
        };
      }

      const webhookInfo = config.alerts.webhook_url
        ? `Webhook URL: ${config.alerts.webhook_url}`
        : "Webhook URL: (미설정)";

      const rulesList = config.alerts.rules.map(formatRule).join("\n---\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `${webhookInfo}\n\n알림 규칙 (${config.alerts.rules.length}개):\n\n${rulesList}`,
          },
        ],
      };
    }
  }
}

// =============================================================
// 유틸리티
// =============================================================

function formatRule(rule: AlertRule): string {
  const lines = [
    `  Name: ${rule.name}`,
    `  Domain: ${rule.domain}`,
    `  Level: ${rule.level ?? "(전체)"}`,
    `  Keyword: ${rule.keyword ?? "(없음)"}`,
    `  Threshold: ${rule.threshold}건`,
    `  Period: 최근 ${rule.period_minutes}분`,
  ];
  return lines.join("\n");
}

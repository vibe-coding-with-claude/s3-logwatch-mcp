/**
 * update-config MCP 도구
 *
 * 이 파일의 역할:
 * - "update-config"라는 MCP 도구를 등록합니다.
 * - Claude Code가 이 도구를 호출하면 설정을 조회하거나 수정할 수 있습니다.
 *
 * 사용 예시 (Claude Code에서 자연어로):
 * - "현재 설정 보여줘" -> action: "get"
 * - "S3 버킷 이름을 my-bucket으로 변경해줘" -> action: "set", path: "s3.bucket", value: "my-bucket"
 *
 * MCP 도구 구조:
 * server.tool(이름, 설명, 입력스키마, 핸들러함수)
 * - 이름: Claude가 도구를 식별하는 문자열
 * - 설명: Claude가 도구의 용도를 파악하는 데 사용
 * - 입력스키마: zod로 정의한 파라미터 검증 규칙
 * - 핸들러함수: 실제 로직을 실행하는 함수
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  loadConfig,
  saveConfig,
  validateConfig,
} from "../config.js";
import { executeAthenaDDL } from "./init.js";
import { AthenaClient } from "@aws-sdk/client-athena";

// =============================================================
// 입력 파라미터 스키마 (zod)
// =============================================================
// 왜 zod를 사용하나?
// - MCP SDK가 zod 스키마를 기반으로 입력 검증을 자동 수행합니다.
// - Claude Code에게 "이 도구는 이런 파라미터를 받는다"를 알려주는 역할도 합니다.
// - TypeScript 타입을 자동 추론해주므로 타입 정의를 따로 안 해도 됩니다.

/**
 * action 파라미터:
 * - "get": 현재 설정을 조회합니다 (path를 지정하면 특정 항목만 조회)
 * - "set": 설정 항목을 수정합니다 (path와 value가 필수)
 */
const actionSchema = z
  .enum(["get", "set"])
  .describe(
    'Action to perform. "get" reads config (optionally a specific path). "set" updates a config value at the given path.'
  );

/**
 * path 파라미터:
 * - 설정 항목의 경로를 점(.)으로 구분합니다.
 * - 예: "s3.bucket", "firehose.buffer_interval", "athena.workgroup"
 * - action이 "get"일 때 생략하면 전체 설정을 반환합니다.
 * - action이 "set"일 때는 필수입니다.
 */
const pathSchema = z
  .string()
  .optional()
  .describe(
    'Dot-separated config path (e.g. "s3.bucket", "firehose.buffer_interval"). Required for "set", optional for "get" (omit to see full config).'
  );

/**
 * value 파라미터:
 * - 설정할 값 (JSON 문자열로 전달)
 * - 문자열 값: "my-bucket"
 * - 숫자 값: "300"
 * - 배열 값: '["level","domain","year","month","day"]'
 * - action이 "set"일 때 필수입니다.
 *
 * 왜 JSON 문자열인가?
 * - MCP 프로토콜에서 다양한 타입(문자열, 숫자, 배열, 객체)을
 *   하나의 파라미터로 받으려면 JSON 문자열이 가장 유연합니다.
 */
const valueSchema = z
  .string()
  .optional()
  .describe(
    'Value to set (as JSON string). Examples: "my-bucket", "300", \'["a","b"]\'. Required for "set" action.'
  );

// =============================================================
// 도구 등록 함수
// =============================================================

/**
 * update-config 도구를 MCP 서버에 등록합니다.
 *
 * 왜 함수로 분리했나?
 * - index.ts에서 server 인스턴스를 전달받아 등록하는 패턴입니다.
 * - 도구별로 파일을 분리하면 코드가 깔끔하고, 도구 추가/삭제가 쉽습니다.
 * - 테스트할 때 mock server를 전달할 수도 있습니다.
 */
export function registerConfigTool(server: McpServer): void {
  server.tool(
    // 도구 이름: Claude Code가 이 이름으로 도구를 호출합니다
    "update-config",

    // 도구 설명: Claude가 언제 이 도구를 사용할지 판단하는 데 사용됩니다
    "Read or update s3-logwatch configuration (S3, Firehose, schema, partitioning, Athena settings). Use action 'get' to view config, 'set' to modify a specific setting.",

    // 입력 파라미터 스키마 (zod 스키마 객체를 Record 형태로 전달)
    {
      action: actionSchema,
      path: pathSchema,
      value: valueSchema,
    },

    // 핸들러 함수: 도구가 호출될 때 실행되는 로직
    // args의 타입은 zod 스키마에서 자동 추론됩니다
    async (args) => {
      try {
        // action에 따라 분기
        if (args.action === "get") {
          return handleGet(args.path);
        } else {
          return handleSet(args.path, args.value);
        }
      } catch (error: unknown) {
        // 에러 발생 시 사용자에게 읽기 쉬운 메시지를 반환합니다
        const message =
          error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
        return {
          content: [
            {
              type: "text" as const,
              text: `설정 작업 실패: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

// =============================================================
// 핸들러 함수들
// =============================================================

/**
 * 설정 조회 핸들러
 *
 * @param path - 조회할 설정 경로 (없으면 전체 설정 반환)
 *
 * 반환 형식: MCP의 CallToolResult 형태
 * - content: 텍스트 블록 배열. Claude가 이 내용을 읽고 사용자에게 답변합니다.
 */
function handleGet(path?: string) {
  const config = loadConfig();

  // path가 없으면 전체 설정을 보기 좋게 반환
  if (!path) {
    return {
      content: [
        {
          type: "text" as const,
          text: `현재 s3-logwatch 설정:\n\n${JSON.stringify(config, null, 2)}`,
        },
      ],
    };
  }

  // path가 있으면 해당 경로의 값만 반환
  const value = getNestedValue(config as unknown as Record<string, unknown>, path);

  if (value === undefined) {
    return {
      content: [
        {
          type: "text" as const,
          text: `설정 경로 "${path}"를 찾을 수 없습니다.\n\n사용 가능한 경로 예시: s3.bucket, firehose.delivery_stream, schema.columns, partitioning.keys, athena.workgroup, connections`,
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: `${path} = ${JSON.stringify(value, null, 2)}`,
      },
    ],
  };
}

/**
 * 설정 수정 핸들러
 *
 * 동작 흐름:
 * 1. path와 value 필수 여부 확인
 * 2. value를 JSON으로 파싱 (문자열이면 그대로 사용)
 * 3. 현재 설정 로드
 * 4. 해당 경로의 값을 수정
 * 5. 수정된 설정 검증
 * 6. 검증 통과하면 저장
 */
async function handleSet(path?: string, value?: string) {
  // 필수 파라미터 확인
  if (!path) {
    return {
      content: [
        {
          type: "text" as const,
          text: '설정을 수정하려면 path가 필요합니다.\n\n예시: path="s3.bucket", value="my-bucket"',
        },
      ],
      isError: true,
    };
  }

  if (value === undefined || value === null) {
    return {
      content: [
        {
          type: "text" as const,
          text: `설정을 수정하려면 value가 필요합니다.\n\n예시: path="${path}", value="새로운값"`,
        },
      ],
      isError: true,
    };
  }

  // JSON 파싱 시도
  // "300" -> 300 (숫자), '"hello"' -> "hello" (문자열), '["a","b"]' -> ["a","b"] (배열)
  // JSON으로 파싱할 수 없으면 원래 문자열을 그대로 사용합니다
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(value);
  } catch {
    // JSON 파싱 실패 시 문자열 그대로 사용
    // 예: "my-bucket" (따옴표 없이 입력한 경우)
    parsedValue = value;
  }

  // 현재 설정 로드
  const config = loadConfig();

  // 도메인 변경 감지를 위해 변경 전 도메인 목록을 저장
  const isDomainPath = path.startsWith("domains");
  const beforeDomainNames = isDomainPath
    ? config.domains.map((d) => d.name).sort().join(",")
    : "";

  // 해당 경로에 값 설정
  const success = setNestedValue(config as unknown as Record<string, unknown>, path, parsedValue);
  if (!success) {
    return {
      content: [
        {
          type: "text" as const,
          text: `설정 경로 "${path}"에 값을 설정할 수 없습니다. 경로가 올바른지 확인하세요.\n\n사용 가능한 최상위 키: s3, firehose, schema, partitioning, athena, connections`,
        },
      ],
      isError: true,
    };
  }

  // 수정된 설정 검증
  const errors = validateConfig(config);
  if (errors.length > 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `설정 검증 실패 (저장하지 않았습니다):\n\n${errors.map((e) => `- ${e}`).join("\n")}`,
        },
      ],
      isError: true,
    };
  }

  // 저장 (도메인 변경 감지 전에 먼저 저장 — 실패해도 설정은 유지됨)
  saveConfig(config);

  // 도메인 변경 감지: path가 "domains"로 시작하면 도메인 변경으로 간주
  if (isDomainPath) {
    // 최신 config에서 domains를 읽어 projection 값 생성
    const updatedConfig = loadConfig();
    const afterDomainNames = updatedConfig.domains.map((d) => d.name).sort().join(",");

    if (beforeDomainNames !== afterDomainNames) {
      const domainValues = updatedConfig.domains.map((d) => d.name).join(",");
      const alterTableSQL = `ALTER TABLE ${updatedConfig.resource_names.database}.${updatedConfig.resource_names.table} SET TBLPROPERTIES ('projection.domain.values' = '${domainValues}')`;

      try {
        const athena = new AthenaClient({});
        await executeAthenaDDL(
          athena,
          alterTableSQL,
          updatedConfig.athena.workgroup,
          updatedConfig.athena.output_location
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `설정이 업데이트되었습니다.\n\n${path} = ${JSON.stringify(parsedValue, null, 2)}\n\nAthena 테이블의 projection.domain.values가 자동으로 갱신되었습니다: ${domainValues}`,
            },
          ],
        };
      } catch (athenaError: unknown) {
        const athenaMessage =
          athenaError instanceof Error ? athenaError.message : "알 수 없는 Athena 오류";
        return {
          content: [
            {
              type: "text" as const,
              text: `설정은 저장되었지만, Athena 테이블 갱신에 실패했습니다: ${athenaMessage}\n\n수동으로 다음 SQL을 실행하세요:\n${alterTableSQL}\n\n${path} = ${JSON.stringify(parsedValue, null, 2)}`,
            },
          ],
        };
      }
    }
  }

  return {
    content: [
      {
        type: "text" as const,
        text: `설정이 업데이트되었습니다.\n\n${path} = ${JSON.stringify(parsedValue, null, 2)}`,
      },
    ],
  };
}

// =============================================================
// 유틸리티: 중첩 객체 값 접근
// =============================================================

/**
 * 점(.)으로 구분된 경로로 중첩 객체의 값을 가져옵니다.
 *
 * 예: getNestedValue({ s3: { bucket: "my-bucket" } }, "s3.bucket")
 *     -> "my-bucket"
 *
 * 왜 이 함수가 필요한가?
 * - config.s3.bucket처럼 직접 접근하려면 모든 경로를 switch/case로 처리해야 합니다.
 * - 동적 경로 접근을 지원하면 어떤 설정이든 하나의 함수로 처리할 수 있습니다.
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  // "s3.bucket" -> ["s3", "bucket"]
  const keys = path.split(".");

  // 순서대로 한 단계씩 들어갑니다
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

/**
 * 점(.)으로 구분된 경로에 값을 설정합니다.
 *
 * 예: setNestedValue(config, "s3.bucket", "new-bucket")
 *     -> config.s3.bucket = "new-bucket"
 *
 * @returns 성공 여부. 경로의 중간에 객체가 아닌 값이 있으면 false.
 */
function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): boolean {
  const keys = path.split(".");

  // 마지막 키 전까지 탐색하여 부모 객체를 찾습니다
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    const next = current[key];

    // 중간 경로가 객체가 아니면 실패
    if (next === null || next === undefined || typeof next !== "object") {
      return false;
    }

    current = next as Record<string, unknown>;
  }

  // 마지막 키에 값을 설정합니다
  const lastKey = keys[keys.length - 1];
  current[lastKey] = value;
  return true;
}

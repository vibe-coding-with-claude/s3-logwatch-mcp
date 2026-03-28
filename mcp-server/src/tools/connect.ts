/**
 * connect-log-group MCP 도구
 *
 * 이 파일의 역할:
 * - CloudWatch Log Group에 Subscription Filter를 설정하여 Firehose로 로그를 전달합니다.
 * - 사용자가 "payment-api 로그 그룹 연결해줘"라고 하면 이 도구가 호출됩니다.
 *
 * Subscription Filter란?
 * - CloudWatch Log Group에 설정하는 필터로, 조건에 맞는 로그를 실시간으로 다른 서비스로 전달합니다.
 * - 여기서는 Firehose로 전달하여, Firehose가 Parquet 변환 후 S3에 저장하게 합니다.
 *
 * 아키텍처: 여러 Log Group -> 하나의 Firehose
 * - 각 Log Group마다 Subscription Filter를 만들되, 목적지는 같은 Firehose입니다.
 * - 서비스가 늘어나도 Firehose와 S3 설정은 변경할 필요 없습니다.
 *
 * 멱등성(Idempotency):
 * - PutSubscriptionFilter는 같은 filterName으로 호출하면 업데이트(upsert) 됩니다.
 * - 두 번 실행해도 에러 없이 동작합니다.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, saveConfig } from "../config.js";

// =============================================================
// AWS SDK v3 클라이언트 import
// =============================================================
// 왜 서비스별로 별도 패키지인가?
// AWS SDK v3는 모듈화되어 있어 필요한 서비스만 import합니다.
// 번들 크기를 최소화하고, 각 API 호출의 타입이 정확합니다.

import {
  CloudWatchLogsClient,
  PutSubscriptionFilterCommand,
} from "@aws-sdk/client-cloudwatch-logs";

import {
  FirehoseClient,
  DescribeDeliveryStreamCommand,
} from "@aws-sdk/client-firehose";

import {
  IAMClient,
  CreateRoleCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";

// =============================================================
// 상수 정의
// =============================================================

/**
 * CloudWatch Logs -> Firehose 전달을 위한 IAM 역할 이름
 *
 * 왜 Firehose용 역할과 별도로 만드나?
 * - init-infra에서 만든 역할은 "Firehose -> S3/Glue" 권한입니다.
 * - 이 역할은 "CloudWatch Logs -> Firehose" 권한으로, 주체(Principal)가 다릅니다.
 * - AWS IAM 모범사례: 서비스마다 최소 권한의 별도 역할을 부여합니다.
 */
const CWL_TO_FIREHOSE_ROLE_NAME = "s3-logwatch-cwl-to-firehose-role";

// =============================================================
// 입력 파라미터 스키마
// =============================================================

/**
 * log_group: CloudWatch Log Group 이름
 * 왜 필수인가? 어떤 Log Group을 연결할지 반드시 알아야 합니다.
 * 예: "/ecs/payment-api", "/ecs/auth-service"
 */
const logGroupSchema = z
  .string()
  .describe(
    'CloudWatch Log Group name to connect. Example: "/ecs/payment-api"'
  );

/**
 * domain: 이 Log Group이 속하는 도메인 이름 (필수)
 * 왜 필수인가? Firehose가 로그의 domain 필드를 보고 S3 경로를 분기하므로,
 * 어떤 도메인에 속하는지 반드시 지정해야 합니다.
 * config.yaml의 domains에 등록된 도메인만 사용할 수 있습니다.
 * 예: "user", "order", "payment"
 */
const domainSchema = z
  .string()
  .describe(
    "Domain name this log group belongs to (e.g. 'user', 'order', 'payment'). Must be one of the domains defined in config.yaml."
  );

/**
 * filter_pattern: Subscription Filter 패턴
 * 왜 optional인가? 빈 문자열이면 모든 로그를 수집하므로, 기본값으로 충분합니다.
 * 예: "ERROR" -> ERROR가 포함된 로그만 수집
 * 예: "" -> 모든 로그 수집
 */
const filterPatternSchema = z
  .string()
  .optional()
  .describe(
    'Subscription Filter pattern. Empty string means all logs. Example: "ERROR" to filter only error logs. Default: "" (all logs)'
  );

/**
 * region: AWS 리전
 * init-infra와 동일한 패턴으로, 기본값은 us-east-1입니다.
 */
const regionSchema = z
  .string()
  .optional()
  .describe(
    'AWS region (default: "us-east-1"). Example: "ap-northeast-2" for Seoul.'
  );

// =============================================================
// 유틸리티: 사용 가능한 도메인 이름 목록 조회
// =============================================================

/**
 * config.yaml에서 사용 가능한 도메인 이름 목록을 가져옵니다.
 *
 * 왜 별도 함수인가?
 * - 도구 설명(description)에 사용 가능한 도메인 목록을 동적으로 포함하기 위해서입니다.
 * - 도구 등록 시점에 config를 읽어서 도메인 목록을 표시합니다.
 *
 * @returns 도메인 이름 문자열 배열 (예: ["user", "order", "payment"])
 */
function getAvailableDomainNames(): string[] {
  try {
    const config = loadConfig();
    return config.domains.map((d) => d.name);
  } catch {
    // 설정 파일을 읽을 수 없는 경우 빈 배열 반환
    return [];
  }
}

// =============================================================
// 도구 등록 함수
// =============================================================

/**
 * connect-log-group 도구를 MCP 서버에 등록합니다.
 *
 * registerInitTool(init.ts)과 동일한 패턴:
 * 1. server.tool()로 도구를 등록
 * 2. 핸들러에서 비즈니스 로직 실행
 * 3. 결과를 MCP CallToolResult 형태로 반환
 */
export function registerConnectTool(server: McpServer): void {
  server.tool(
    // 도구 이름: Claude Code가 이 이름으로 도구를 호출합니다
    "connect-log-group",

    // 도구 설명: Claude가 "payment-api 로그 연결해줘" 같은 요청을 이 도구에 매핑하는 데 사용
    // domain 파라미터가 필수임을 명시하고, 사용 가능한 도메인 목록을 동적으로 포함합니다.
    `Connect a CloudWatch Log Group to the s3-logwatch pipeline via Subscription Filter. ` +
      `Requires a 'domain' parameter to specify which domain this log group belongs to. ` +
      `Available domains: ${getAvailableDomainNames().join(", ")}. ` +
      `Logs matching the filter pattern will be streamed to Firehose and stored in S3. ` +
      `Safe to run multiple times (idempotent - updates existing filter).`,

    // 입력 파라미터 스키마 (domain 추가)
    {
      log_group: logGroupSchema,
      domain: domainSchema,
      filter_pattern: filterPatternSchema,
      region: regionSchema,
    },

    // 핸들러 함수
    async (args) => {
      try {
        const result = await connectLogGroup(
          args.log_group,
          args.domain,
          args.filter_pattern,
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
              text: `Log Group 연결 실패: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

// =============================================================
// 메인 연결 로직
// =============================================================

/**
 * CloudWatch Log Group을 Firehose에 연결하는 전체 흐름입니다.
 *
 * 순서:
 * 1. config.yaml에서 Firehose 이름 가져오기
 * 2. Firehose의 ARN 조회 (DescribeDeliveryStream)
 * 3. IAM 역할 확인/생성 (CloudWatch Logs -> Firehose 전달 권한)
 * 4. Subscription Filter 생성 (PutSubscriptionFilter는 upsert 동작)
 * 5. config.yaml의 connections 목록 업데이트
 *
 * @param logGroup - CloudWatch Log Group 이름
 * @param domain - 이 Log Group이 속하는 도메인 이름 (필수)
 * @param filterPattern - 필터 패턴 (기본값: "" = 전체 로그)
 * @param region - AWS 리전 (기본값: us-east-1)
 * @returns 성공 메시지 문자열
 */
async function connectLogGroup(
  logGroup: string,
  domain: string,
  filterPattern?: string,
  region?: string
): Promise<string> {
  const resolvedRegion = region ?? "us-east-1";
  const resolvedFilterPattern = filterPattern ?? "";

  // --- (1) config.yaml에서 Firehose delivery stream 이름 가져오기 ---
  // 왜 config에서 읽나? init-infra에서 생성한 Firehose 이름을 일관되게 사용하기 위해서입니다.
  const config = loadConfig();
  const deliveryStreamName = config.firehose.delivery_stream;

  if (!deliveryStreamName) {
    throw new Error(
      "config.yaml에 firehose.delivery_stream이 설정되어 있지 않습니다. " +
        "먼저 init-infra 도구를 실행하여 인프라를 초기화해주세요."
    );
  }

  // --- (1.5) domain 검증 ---
  // 입력된 domain이 config.yaml의 domains 목록에 존재하는지 확인합니다.
  // 존재하지 않는 도메인을 사용하면 로그가 올바른 S3 경로에 저장되지 않습니다.
  const availableDomains = config.domains.map((d) => d.name);
  if (!availableDomains.includes(domain)) {
    throw new Error(
      `도메인 '${domain}'이 존재하지 않습니다. ` +
        `사용 가능한 도메인: ${availableDomains.join(", ")}`
    );
  }

  // AWS SDK 클라이언트 생성
  // 왜 매번 생성하나? 리전이 호출마다 다를 수 있으므로 클라이언트도 매번 새로 만듭니다.
  const firehoseClient = new FirehoseClient({ region: resolvedRegion });
  // IAM은 글로벌 서비스이지만, SDK 클라이언트는 리전을 요구합니다
  const iamClient = new IAMClient({ region: resolvedRegion });
  const cwlClient = new CloudWatchLogsClient({ region: resolvedRegion });

  // --- (2) Firehose delivery stream의 ARN 가져오기 ---
  // 왜 ARN이 필요한가? Subscription Filter의 destinationArn에 Firehose ARN을 지정해야 합니다.
  // 이름만으로는 AWS가 어떤 리소스인지 식별할 수 없습니다.
  const firehoseArn = await getFirehoseArn(firehoseClient, deliveryStreamName);

  // --- (3) IAM 역할 확인/생성 ---
  // CloudWatch Logs 서비스가 Firehose에 로그를 전달하려면 IAM 역할이 필요합니다.
  // Trust Policy: logs.{region}.amazonaws.com 이 역할을 assume할 수 있음
  // Permission: firehose:PutRecord, firehose:PutRecordBatch
  const roleArn = await ensureCwlToFirehoseRole(
    iamClient,
    firehoseArn,
    resolvedRegion
  );

  // --- (4) Subscription Filter 생성 ---
  // PutSubscriptionFilter는 같은 filterName이 이미 있으면 업데이트합니다 (upsert 동작).
  // 따라서 멱등성이 자동으로 보장됩니다.
  const filterName = buildFilterName(logGroup, domain);
  await cwlClient.send(
    new PutSubscriptionFilterCommand({
      // filterName: Subscription Filter를 식별하는 고유 이름
      // Log Group 이름에서 슬래시를 하이픈으로 변환하여 유효한 이름을 만듭니다
      filterName,
      // logGroupName: 어떤 Log Group의 로그를 수집할지
      logGroupName: logGroup,
      // filterPattern: 어떤 로그를 필터링할지 (빈 문자열이면 모든 로그)
      filterPattern: resolvedFilterPattern,
      // destinationArn: 필터링된 로그가 전달될 Firehose의 ARN
      destinationArn: firehoseArn,
      // roleArn: CloudWatch Logs가 Firehose에 데이터를 쓸 때 사용하는 IAM 역할
      roleArn,
    })
  );

  // --- (5) config.yaml의 connections 목록 업데이트 ---
  // 왜 config에 기록하나? 어떤 Log Group이 연결되어 있는지 추적하기 위해서입니다.
  // 이미 존재하는 log_group이면 filter_pattern을 업데이트합니다.
  updateConnections(config, logGroup, resolvedFilterPattern, domain);
  saveConfig(config);

  // --- (6) 결과 메시지 반환 ---
  const filterInfo =
    resolvedFilterPattern === ""
      ? "모든 로그"
      : `"${resolvedFilterPattern}" 패턴 매칭 로그`;

  return [
    `Log Group 연결 완료!`,
    ``,
    `  Log Group:      ${logGroup}`,
    `  Domain:         ${domain}`,
    `  Filter:         ${filterInfo}`,
    `  Filter Name:    ${filterName}`,
    `  Firehose:       ${deliveryStreamName}`,
    `  IAM Role:       ${CWL_TO_FIREHOSE_ROLE_NAME}`,
    ``,
    `이제 ${logGroup}의 로그가 '${domain}' 도메인으로 Firehose를 통해 S3에 저장됩니다.`,
    `다른 Log Group도 연결하려면 connect-log-group 도구를 다시 호출하세요.`,
  ].join("\n");
}

// =============================================================
// Firehose ARN 조회
// =============================================================

/**
 * Firehose delivery stream의 ARN을 조회합니다.
 *
 * 왜 DescribeDeliveryStream을 사용하나?
 * - Firehose ARN은 계정 ID와 리전이 포함되어 있어 직접 구성하기 어렵습니다.
 * - API로 조회하면 정확한 ARN을 얻을 수 있습니다.
 * - 동시에 Firehose가 실제로 존재하는지 확인하는 효과도 있습니다.
 *
 * @param client - Firehose SDK 클라이언트
 * @param streamName - delivery stream 이름
 * @returns Firehose ARN 문자열
 */
async function getFirehoseArn(
  client: FirehoseClient,
  streamName: string
): Promise<string> {
  try {
    const response = await client.send(
      new DescribeDeliveryStreamCommand({
        DeliveryStreamName: streamName,
      })
    );

    const arn =
      response.DeliveryStreamDescription?.DeliveryStreamARN;
    if (!arn) {
      throw new Error(
        `Firehose '${streamName}'의 ARN을 가져올 수 없습니다.`
      );
    }

    return arn;
  } catch (error: unknown) {
    const errorName = (error as { name?: string })?.name ?? "";
    // ResourceNotFoundException: Firehose가 존재하지 않을 때
    if (errorName === "ResourceNotFoundException") {
      throw new Error(
        `Firehose '${streamName}'가 존재하지 않습니다. ` +
          `먼저 init-infra 도구를 실행하여 인프라를 초기화해주세요.`
      );
    }
    throw error;
  }
}

// =============================================================
// IAM 역할 확인/생성
// =============================================================

/**
 * CloudWatch Logs -> Firehose 전달을 위한 IAM 역할을 확인하고, 없으면 생성합니다.
 *
 * 왜 별도의 IAM 역할이 필요한가?
 * - CloudWatch Logs 서비스가 Firehose에 데이터를 쓰려면 권한이 필요합니다.
 * - Subscription Filter에 roleArn을 지정하면, CloudWatch Logs가 해당 역할을 assume합니다.
 * - Trust Policy의 Principal이 logs.{region}.amazonaws.com 이어야 합니다.
 *
 * 멱등성:
 * - 역할이 이미 존재하면 ARN만 반환합니다.
 * - 새로 생성할 때는 Trust Policy + Inline Policy를 함께 설정합니다.
 *
 * @param client - IAM SDK 클라이언트
 * @param firehoseArn - 대상 Firehose delivery stream의 ARN
 * @param region - AWS 리전 (Trust Policy에 사용)
 * @returns IAM 역할 ARN
 */
async function ensureCwlToFirehoseRole(
  client: IAMClient,
  firehoseArn: string,
  region: string
): Promise<string> {
  // 먼저 역할이 이미 존재하는지 확인합니다
  try {
    const existing = await client.send(
      new GetRoleCommand({ RoleName: CWL_TO_FIREHOSE_ROLE_NAME })
    );
    const arn = existing.Role?.Arn;
    if (arn) {
      // 역할이 이미 존재하면 정책만 업데이트합니다
      // 왜 정책을 업데이트하나? 새로운 Firehose ARN이 추가되었을 수 있기 때문입니다.
      // PutRolePolicy는 같은 PolicyName이면 덮어씌우는 upsert 동작입니다.
      await putFirehosePermissionPolicy(client, firehoseArn);
      return arn;
    }
  } catch (error: unknown) {
    const errorName = (error as { name?: string })?.name ?? "";
    // NoSuchEntityException: 역할이 존재하지 않음 -> 아래에서 새로 생성
    if (errorName !== "NoSuchEntityException") {
      throw error;
    }
  }

  // 역할이 없으므로 새로 생성합니다

  // Trust Policy: 누가 이 역할을 assume(사용)할 수 있는가?
  // logs.{region}.amazonaws.com = 해당 리전의 CloudWatch Logs 서비스
  // 왜 리전별인가? CloudWatch Logs는 리전별 서비스이므로, 정확한 리전을 지정합니다.
  const trustPolicy = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: {
          Service: `logs.${region}.amazonaws.com`,
        },
        Action: "sts:AssumeRole",
      },
    ],
  };

  const createResult = await client.send(
    new CreateRoleCommand({
      RoleName: CWL_TO_FIREHOSE_ROLE_NAME,
      AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
      Description:
        "s3-logwatch: CloudWatch Logs가 Firehose로 로그를 전달하기 위한 역할",
    })
  );

  const roleArn = createResult.Role?.Arn;
  if (!roleArn) {
    throw new Error("IAM 역할 생성 후 ARN을 가져올 수 없습니다.");
  }

  // Inline Policy 추가: Firehose에 데이터를 쓸 수 있는 권한
  await putFirehosePermissionPolicy(client, firehoseArn);

  return roleArn;
}

/**
 * CloudWatch Logs -> Firehose 전달을 위한 권한 정책을 IAM 역할에 추가합니다.
 *
 * PutRolePolicy는 같은 PolicyName이면 덮어씌우는 upsert 동작이므로,
 * 역할 생성 시에도, 기존 역할 업데이트 시에도 동일하게 호출할 수 있습니다.
 *
 * 왜 PutRecord와 PutRecordBatch 두 가지 권한인가?
 * - PutRecord: 단일 레코드 전달
 * - PutRecordBatch: 여러 레코드를 한번에 전달 (CloudWatch Logs가 주로 사용)
 * - 두 가지 모두 필요합니다.
 *
 * @param client - IAM SDK 클라이언트
 * @param firehoseArn - 대상 Firehose delivery stream의 ARN
 */
async function putFirehosePermissionPolicy(
  client: IAMClient,
  firehoseArn: string
): Promise<void> {
  const inlinePolicy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "FirehoseAccess",
        Effect: "Allow",
        Action: ["firehose:PutRecord", "firehose:PutRecordBatch"],
        // 왜 특정 Firehose ARN만 허용하나?
        // 최소 권한 원칙: 이 역할은 우리 Firehose에만 데이터를 쓸 수 있어야 합니다.
        Resource: firehoseArn,
      },
    ],
  };

  await client.send(
    new PutRolePolicyCommand({
      RoleName: CWL_TO_FIREHOSE_ROLE_NAME,
      PolicyName: "s3-logwatch-cwl-to-firehose-policy",
      PolicyDocument: JSON.stringify(inlinePolicy),
    })
  );
}

// =============================================================
// Subscription Filter 이름 생성
// =============================================================

/**
 * Log Group 이름에서 Subscription Filter 이름을 생성합니다.
 *
 * 변환 규칙:
 * - 앞뒤 슬래시를 제거합니다
 * - 슬래시(/)를 하이픈(-)으로 변환합니다
 * - "s3-logwatch-{domain}-" 접두사를 붙입니다
 *
 * 예: domain="payment", logGroup="/ecs/payment-api"
 *     -> "s3-logwatch-payment-ecs-payment-api"
 *
 * 왜 domain을 이름에 포함하나?
 * - 같은 Log Group이 다른 도메인으로 재연결될 때 필터 이름이 달라져야 합니다.
 * - 필터 이름만 보고도 어떤 도메인에 속하는지 식별할 수 있습니다.
 *
 * @param logGroup - CloudWatch Log Group 이름
 * @param domain - 도메인 이름
 * @returns Subscription Filter 이름
 */
function buildFilterName(logGroup: string, domain: string): string {
  // 앞뒤 슬래시 제거 후 나머지 슬래시를 하이픈으로 변환
  const sanitized = logGroup.replace(/^\/+|\/+$/g, "").replace(/\//g, "-");
  return `s3-logwatch-${domain}-${sanitized}`;
}

// =============================================================
// config.yaml connections 업데이트
// =============================================================

/**
 * config.yaml의 connections 목록을 업데이트합니다.
 *
 * 동작:
 * - 같은 log_group이 이미 있으면 filter_pattern을 업데이트합니다.
 * - 없으면 새로 추가합니다.
 *
 * 왜 config에 기록하나?
 * - 어떤 Log Group이 연결되어 있는지 한눈에 파악할 수 있습니다.
 * - disconnect 기능을 만들 때 목록이 필요합니다.
 * - 사용자가 config.yaml을 직접 확인할 수도 있습니다.
 *
 * @param config - 현재 AppConfig 객체 (직접 수정됩니다)
 * @param logGroup - Log Group 이름
 * @param filterPattern - 필터 패턴
 * @param domain - 이 Log Group이 속하는 도메인 이름
 */
function updateConnections(
  config: { connections: { log_group: string; filter_pattern: string; domain: string }[] },
  logGroup: string,
  filterPattern: string,
  domain: string
): void {
  // 이미 존재하는 연결인지 찾습니다
  const existingIndex = config.connections.findIndex(
    (c) => c.log_group === logGroup
  );

  if (existingIndex >= 0) {
    // 이미 존재하면 filter_pattern과 domain을 업데이트
    config.connections[existingIndex].filter_pattern = filterPattern;
    config.connections[existingIndex].domain = domain;
  } else {
    // 새로운 연결 추가 (domain 포함)
    config.connections.push({
      log_group: logGroup,
      filter_pattern: filterPattern,
      domain,
    });
  }
}

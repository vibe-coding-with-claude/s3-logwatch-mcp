/**
 * destroy-infra MCP 도구
 *
 * 이 파일의 역할:
 * - "destroy-infra"라는 MCP 도구를 등록합니다.
 * - init-infra로 생성한 AWS 리소스를 역순으로 삭제합니다.
 * - S3 버킷은 force_delete_s3=true일 때만 삭제합니다 (데이터 보호).
 *
 * 멱등성(Idempotency):
 * - 이미 삭제된(존재하지 않는) 리소스는 스킵합니다.
 * - 두 번 실행해도 에러 없이 동작합니다.
 *
 * 삭제 순서 (생성의 역순):
 * 1. Subscription Filters (Log Group -> Firehose 연결 해제)
 * 2. Firehose Delivery Stream
 * 3. Lambda (현재 미사용, 향후 확장용)
 * 4. IAM 역할 (인라인 정책 먼저 삭제 후 역할 삭제)
 * 5. Athena 테이블/데이터베이스 (DDL DROP)
 * 6. S3 버킷 (force_delete_s3=true일 때만)
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, saveConfig } from "../config.js";
import { executeAthenaDDL } from "./init.js";

// =============================================================
// AWS SDK v3 클라이언트 import
// =============================================================

import {
  CloudWatchLogsClient,
  DeleteSubscriptionFilterCommand,
} from "@aws-sdk/client-cloudwatch-logs";

import {
  FirehoseClient,
  DeleteDeliveryStreamCommand,
  DescribeDeliveryStreamCommand,
} from "@aws-sdk/client-firehose";

import {
  IAMClient,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  GetRoleCommand,
  ListRolePoliciesCommand,
} from "@aws-sdk/client-iam";

import {
  AthenaClient,
  DeleteWorkGroupCommand,
  GetWorkGroupCommand,
} from "@aws-sdk/client-athena";

import {
  S3Client,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

// =============================================================
// 타입 정의
// =============================================================

/** 각 리소스의 삭제 결과 상태 */
type DestroyStatus = "deleted" | "not_found" | "failed" | "skipped";

/** 하나의 리소스 삭제 결과 */
interface DestroyResult {
  name: string;
  status: DestroyStatus;
  detail: string;
}

// =============================================================
// 상수 정의
// =============================================================

/** Athena/Glue 데이터베이스 이름 (init.ts와 동일) */
const DATABASE_NAME = "s3_logwatch";

/** Athena/Glue 테이블 이름 (init.ts와 동일) */
const TABLE_NAME = "logs";

/** Firehose용 IAM 역할 이름 (init.ts와 동일) */
const FIREHOSE_ROLE_NAME = "s3-logwatch-firehose-role";

/** CloudWatch Logs -> Firehose 전달을 위한 IAM 역할 이름 (connect.ts와 동일) */
const CWL_TO_FIREHOSE_ROLE_NAME = "s3-logwatch-cwl-to-firehose-role";

// =============================================================
// 입력 파라미터 스키마
// =============================================================

const regionSchema = z
  .string()
  .optional()
  .describe(
    'AWS region (default: "us-east-1"). Example: "ap-northeast-2" for Seoul.'
  );

const forceDeleteS3Schema = z
  .boolean()
  .optional()
  .describe(
    "S3 버킷도 함께 삭제할지 여부. 기본값 false (데이터 보호). " +
      "true로 설정하면 버킷 내 모든 객체를 삭제한 후 버킷을 삭제합니다."
  );

// =============================================================
// 도구 등록 함수
// =============================================================

/**
 * destroy-infra 도구를 MCP 서버에 등록합니다.
 */
export function registerDestroyTool(server: McpServer): void {
  server.tool(
    // 도구 이름
    "destroy-infra",

    // 도구 설명
    "Destroy all AWS infrastructure created by s3-logwatch (init-infra). " +
      "Deletes resources in reverse order: Subscription Filters, Firehose, IAM roles, " +
      "Athena table/database, and optionally S3 bucket. " +
      "Safe to run multiple times (idempotent - skips already-deleted resources). " +
      "S3 bucket is preserved by default to protect data; set force_delete_s3=true to delete it.",

    // 입력 파라미터 스키마
    {
      region: regionSchema,
      force_delete_s3: forceDeleteS3Schema,
    },

    // 핸들러 함수
    async (args) => {
      try {
        const results = await destroyInfra(
          args.region,
          args.force_delete_s3 ?? false
        );
        return formatDestroyResults(results);
      } catch (error: unknown) {
        const message =
          error instanceof Error
            ? error.message
            : "알 수 없는 오류가 발생했습니다.";
        return {
          content: [
            {
              type: "text" as const,
              text: `인프라 삭제 실패: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

// =============================================================
// 메인 삭제 로직
// =============================================================

/**
 * 모든 AWS 리소스를 역순으로 삭제합니다.
 *
 * 역순 삭제가 필요한 이유:
 * - 의존 관계가 있는 리소스는 피의존 리소스를 먼저 삭제해야 합니다.
 * - 예: Firehose를 삭제해야 IAM 역할을 삭제할 수 있습니다.
 *
 * @param region - AWS 리전 (기본값: us-east-1)
 * @param forceDeleteS3 - S3 버킷 삭제 여부 (기본값: false)
 * @returns 각 리소스별 삭제 결과 배열
 */
async function destroyInfra(
  region?: string,
  forceDeleteS3: boolean = false
): Promise<DestroyResult[]> {
  const resolvedRegion = region ?? "us-east-1";
  const config = loadConfig();
  const results: DestroyResult[] = [];

  // AWS SDK 클라이언트 생성
  const cwlClient = new CloudWatchLogsClient({ region: resolvedRegion });
  const firehoseClient = new FirehoseClient({ region: resolvedRegion });
  const iamClient = new IAMClient({ region: resolvedRegion });
  const athenaClient = new AthenaClient({ region: resolvedRegion });
  const s3Client = new S3Client({ region: resolvedRegion });

  // --- (1) Subscription Filters 삭제 ---
  // config.yaml의 connections에 등록된 모든 Subscription Filter를 삭제합니다.
  const filterResults = await deleteAllSubscriptionFilters(cwlClient, config);
  results.push(...filterResults);

  // connections를 모두 삭제했으므로 config.yaml에서도 제거합니다.
  if (filterResults.length > 0) {
    config.connections = [];
    saveConfig(config);
  }

  // --- (2) Firehose Delivery Stream 삭제 ---
  results.push(
    await deleteFirehoseStream(firehoseClient, config.firehose.delivery_stream)
  );

  // --- (3) IAM 역할 삭제 ---
  // Firehose용 역할과 CWL->Firehose 전달용 역할 두 개를 삭제합니다.
  results.push(await deleteIamRole(iamClient, FIREHOSE_ROLE_NAME));
  results.push(await deleteIamRole(iamClient, CWL_TO_FIREHOSE_ROLE_NAME));

  // --- (4) Athena 테이블/데이터베이스 삭제 ---
  results.push(await deleteAthenaResources(athenaClient, config));

  // --- (5) Athena 워크그룹 삭제 ---
  results.push(
    await deleteAthenaWorkgroup(athenaClient, config.athena.workgroup)
  );

  // --- (6) S3 버킷 삭제 (force_delete_s3=true일 때만) ---
  if (forceDeleteS3) {
    results.push(await deleteS3Bucket(s3Client, config.s3.bucket));
  } else {
    results.push({
      name: "S3 Bucket",
      status: "skipped",
      detail: `s3://${config.s3.bucket} (데이터 보호를 위해 보존됨. 삭제하려면 force_delete_s3=true 사용)`,
    });
  }

  return results;
}

// =============================================================
// (1) Subscription Filters 삭제
// =============================================================

/**
 * config.yaml에 등록된 모든 Subscription Filter를 삭제합니다.
 *
 * 왜 connections에서 가져오나?
 * - connect-log-group으로 연결한 모든 Log Group의 필터를 삭제해야 합니다.
 * - config.yaml의 connections 목록이 연결된 Log Group의 레지스트리 역할을 합니다.
 *
 * @param client - CloudWatch Logs SDK 클라이언트
 * @param config - 현재 AppConfig
 * @returns 각 필터별 삭제 결과 배열
 */
async function deleteAllSubscriptionFilters(
  client: CloudWatchLogsClient,
  config: ReturnType<typeof loadConfig>
): Promise<DestroyResult[]> {
  const results: DestroyResult[] = [];

  // connections가 비어있으면 삭제할 필터가 없음
  if (config.connections.length === 0) {
    return results;
  }

  for (const conn of config.connections) {
    const filterName = buildFilterName(conn.log_group, conn.domain);
    results.push(
      await deleteSubscriptionFilter(client, conn.log_group, filterName)
    );
  }

  return results;
}

/**
 * 단일 Subscription Filter를 삭제합니다.
 *
 * 멱등성: ResourceNotFoundException이 발생하면 이미 삭제된 것으로 간주합니다.
 */
async function deleteSubscriptionFilter(
  client: CloudWatchLogsClient,
  logGroupName: string,
  filterName: string
): Promise<DestroyResult> {
  try {
    await client.send(
      new DeleteSubscriptionFilterCommand({
        logGroupName,
        filterName,
      })
    );
    return {
      name: "Subscription Filter",
      status: "deleted",
      detail: `${filterName} (Log Group: ${logGroupName})`,
    };
  } catch (error: unknown) {
    const errorName = (error as { name?: string })?.name ?? "";
    // 필터가 존재하지 않으면 스킵
    if (
      errorName === "ResourceNotFoundException" ||
      errorName === "ResourceNotFoundError"
    ) {
      return {
        name: "Subscription Filter",
        status: "not_found",
        detail: `${filterName} (이미 삭제됨)`,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "Subscription Filter",
      status: "failed",
      detail: `${filterName} - ${message}`,
    };
  }
}

// =============================================================
// (2) Firehose Delivery Stream 삭제
// =============================================================

/**
 * Firehose Delivery Stream을 삭제합니다.
 *
 * 멱등성: ResourceNotFoundException이면 이미 삭제된 것으로 간주합니다.
 * AllowForceDelete: true로 설정하여 활성 상태의 스트림도 삭제 가능하게 합니다.
 */
async function deleteFirehoseStream(
  client: FirehoseClient,
  streamName: string
): Promise<DestroyResult> {
  // 먼저 존재 여부 확인
  try {
    await client.send(
      new DescribeDeliveryStreamCommand({
        DeliveryStreamName: streamName,
      })
    );
  } catch (error: unknown) {
    const errorName = (error as { name?: string })?.name ?? "";
    if (errorName === "ResourceNotFoundException") {
      return {
        name: "Firehose Stream",
        status: "not_found",
        detail: `${streamName} (이미 삭제됨)`,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "Firehose Stream",
      status: "failed",
      detail: `${streamName} - ${message}`,
    };
  }

  // 존재하면 삭제
  try {
    await client.send(
      new DeleteDeliveryStreamCommand({
        DeliveryStreamName: streamName,
        AllowForceDelete: true,
      })
    );
    return {
      name: "Firehose Stream",
      status: "deleted",
      detail: streamName,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "Firehose Stream",
      status: "failed",
      detail: `${streamName} - ${message}`,
    };
  }
}

// =============================================================
// (3) IAM 역할 삭제
// =============================================================

/**
 * IAM 역할을 삭제합니다.
 *
 * IAM 역할 삭제 전에 인라인 정책을 먼저 삭제해야 합니다.
 * AWS IAM은 정책이 붙어있는 역할을 삭제할 수 없습니다.
 *
 * 삭제 순서:
 * 1. ListRolePolicies로 인라인 정책 목록 조회
 * 2. 각 인라인 정책 삭제 (DeleteRolePolicy)
 * 3. 역할 삭제 (DeleteRole)
 *
 * 멱등성: NoSuchEntityException이면 이미 삭제된 것으로 간주합니다.
 */
async function deleteIamRole(
  client: IAMClient,
  roleName: string
): Promise<DestroyResult> {
  // 역할 존재 여부 확인
  try {
    await client.send(new GetRoleCommand({ RoleName: roleName }));
  } catch (error: unknown) {
    const errorName = (error as { name?: string })?.name ?? "";
    if (errorName === "NoSuchEntityException") {
      return {
        name: "IAM Role",
        status: "not_found",
        detail: `${roleName} (이미 삭제됨)`,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "IAM Role",
      status: "failed",
      detail: `${roleName} - ${message}`,
    };
  }

  try {
    // 인라인 정책 목록 조회 후 삭제
    const policiesResponse = await client.send(
      new ListRolePoliciesCommand({ RoleName: roleName })
    );
    const policyNames = policiesResponse.PolicyNames ?? [];

    for (const policyName of policyNames) {
      await client.send(
        new DeleteRolePolicyCommand({
          RoleName: roleName,
          PolicyName: policyName,
        })
      );
    }

    // 역할 삭제
    await client.send(new DeleteRoleCommand({ RoleName: roleName }));
    return {
      name: "IAM Role",
      status: "deleted",
      detail: `${roleName} (인라인 정책 ${policyNames.length}개 포함)`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "IAM Role",
      status: "failed",
      detail: `${roleName} - ${message}`,
    };
  }
}

// =============================================================
// (4) Athena 테이블/데이터베이스 삭제
// =============================================================

/**
 * Athena DDL로 테이블과 데이터베이스를 삭제합니다.
 *
 * 순서:
 * 1. DROP TABLE IF EXISTS - 테이블 삭제
 * 2. DROP DATABASE IF EXISTS - 데이터베이스 삭제
 *
 * IF EXISTS를 사용하므로 멱등성이 보장됩니다.
 * 워크그룹이 없으면 DDL 실행이 불가능하므로 워크그룹 삭제보다 먼저 실행해야 합니다.
 */
async function deleteAthenaResources(
  athenaClient: AthenaClient,
  config: ReturnType<typeof loadConfig>
): Promise<DestroyResult> {
  const workgroup = config.athena.workgroup;
  const outputLocation = config.athena.output_location;

  try {
    // 워크그룹 존재 여부 먼저 확인 (워크그룹이 없으면 DDL 실행 불가)
    try {
      await athenaClient.send(
        new GetWorkGroupCommand({ WorkGroup: workgroup })
      );
    } catch {
      // 워크그룹이 없으면 DDL 실행이 불가능 -> 테이블/DB도 이미 삭제된 것으로 간주
      return {
        name: "Athena Table/Database",
        status: "not_found",
        detail: `${DATABASE_NAME}.${TABLE_NAME} (워크그룹 없음, 이미 삭제된 것으로 간주)`,
      };
    }

    // 테이블 삭제
    await executeAthenaDDL(
      athenaClient,
      `DROP TABLE IF EXISTS ${DATABASE_NAME}.${TABLE_NAME}`,
      workgroup,
      outputLocation
    );

    // 데이터베이스 삭제
    await executeAthenaDDL(
      athenaClient,
      `DROP DATABASE IF EXISTS ${DATABASE_NAME}`,
      workgroup,
      outputLocation
    );

    return {
      name: "Athena Table/Database",
      status: "deleted",
      detail: `${DATABASE_NAME}.${TABLE_NAME} (DDL DROP 실행)`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "Athena Table/Database",
      status: "failed",
      detail: `${DATABASE_NAME}.${TABLE_NAME} - ${message}`,
    };
  }
}

// =============================================================
// (5) Athena 워크그룹 삭제
// =============================================================

/**
 * Athena 워크그룹을 삭제합니다.
 *
 * RecursiveDeleteOption: true로 설정하여 워크그룹 내 쿼리 이력도 함께 삭제합니다.
 * 멱등성: InvalidRequestException(워크그룹 없음)이면 스킵합니다.
 */
async function deleteAthenaWorkgroup(
  client: AthenaClient,
  workgroupName: string
): Promise<DestroyResult> {
  // 존재 여부 확인
  try {
    await client.send(
      new GetWorkGroupCommand({ WorkGroup: workgroupName })
    );
  } catch {
    return {
      name: "Athena Workgroup",
      status: "not_found",
      detail: `${workgroupName} (이미 삭제됨)`,
    };
  }

  try {
    await client.send(
      new DeleteWorkGroupCommand({
        WorkGroup: workgroupName,
        RecursiveDeleteOption: true,
      })
    );
    return {
      name: "Athena Workgroup",
      status: "deleted",
      detail: workgroupName,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "Athena Workgroup",
      status: "failed",
      detail: `${workgroupName} - ${message}`,
    };
  }
}

// =============================================================
// (6) S3 버킷 삭제
// =============================================================

/**
 * S3 버킷을 삭제합니다.
 *
 * 버킷 삭제 전에 모든 객체를 먼저 삭제해야 합니다.
 * AWS S3는 비어있지 않은 버킷을 삭제할 수 없습니다.
 *
 * 삭제 순서:
 * 1. ListObjectsV2로 객체 목록 조회 (1000개씩 페이징)
 * 2. DeleteObjects로 객체 일괄 삭제
 * 3. 모든 객체 삭제 후 DeleteBucket으로 버킷 삭제
 *
 * 멱등성: NotFound/NoSuchBucket이면 이미 삭제된 것으로 간주합니다.
 */
async function deleteS3Bucket(
  client: S3Client,
  bucketName: string
): Promise<DestroyResult> {
  // 버킷 존재 여부 확인
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucketName }));
  } catch (error: unknown) {
    const errorName = (error as { name?: string })?.name ?? "";
    if (
      errorName === "NotFound" ||
      errorName === "404" ||
      errorName === "NoSuchBucket"
    ) {
      return {
        name: "S3 Bucket",
        status: "not_found",
        detail: `s3://${bucketName} (이미 삭제됨)`,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "S3 Bucket",
      status: "failed",
      detail: `s3://${bucketName} - ${message}`,
    };
  }

  try {
    // 버킷 내 모든 객체 삭제 (페이징 처리)
    let continuationToken: string | undefined;
    let deletedObjectCount = 0;

    do {
      const listResponse = await client.send(
        new ListObjectsV2Command({
          Bucket: bucketName,
          ContinuationToken: continuationToken,
        })
      );

      const objects = listResponse.Contents;
      if (objects && objects.length > 0) {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: {
              Objects: objects.map((obj) => ({ Key: obj.Key })),
              Quiet: true,
            },
          })
        );
        deletedObjectCount += objects.length;
      }

      continuationToken = listResponse.IsTruncated
        ? listResponse.NextContinuationToken
        : undefined;
    } while (continuationToken);

    // 버킷 삭제
    await client.send(new DeleteBucketCommand({ Bucket: bucketName }));
    return {
      name: "S3 Bucket",
      status: "deleted",
      detail: `s3://${bucketName} (객체 ${deletedObjectCount}개 삭제 후 버킷 삭제)`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "S3 Bucket",
      status: "failed",
      detail: `s3://${bucketName} - ${message}`,
    };
  }
}

// =============================================================
// Subscription Filter 이름 생성 (connect.ts의 buildFilterName과 동일)
// =============================================================

/**
 * Log Group 이름에서 Subscription Filter 이름을 생성합니다.
 * connect.ts의 buildFilterName과 동일한 로직입니다.
 *
 * @param logGroup - CloudWatch Log Group 이름
 * @param domain - 도메인 이름
 * @returns Subscription Filter 이름
 */
function buildFilterName(logGroup: string, domain: string): string {
  const sanitized = logGroup.replace(/^\/+|\/+$/g, "").replace(/\//g, "-");
  return `s3-logwatch-${domain}-${sanitized}`;
}

// =============================================================
// 결과 포매팅
// =============================================================

/**
 * 리소스 삭제 결과를 MCP CallToolResult 형태로 포매팅합니다.
 */
function formatDestroyResults(results: DestroyResult[]) {
  const statusLabels: Record<DestroyStatus, string> = {
    deleted: "[deleted]",
    not_found: "[not_found]",
    failed: "[FAILED]",
    skipped: "[skipped]",
  };

  const lines = results.map(
    (r) => `${statusLabels[r.status]} ${r.name}: ${r.detail}`
  );

  const deletedCount = results.filter((r) => r.status === "deleted").length;
  const notFoundCount = results.filter((r) => r.status === "not_found").length;
  const failedCount = results.filter((r) => r.status === "failed").length;
  const skippedCount = results.filter((r) => r.status === "skipped").length;

  const summary =
    `\n--- 요약 ---\n` +
    `삭제: ${deletedCount}개 | 없음: ${notFoundCount}개 | ` +
    `스킵: ${skippedCount}개 | 실패: ${failedCount}개`;

  const hasFailure = failedCount > 0;

  return {
    content: [
      {
        type: "text" as const,
        text: `s3-logwatch 인프라 삭제 결과:\n\n${lines.join("\n")}${summary}`,
      },
    ],
    isError: hasFailure,
  };
}

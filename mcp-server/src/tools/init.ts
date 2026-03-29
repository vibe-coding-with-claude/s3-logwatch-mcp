/**
 * init-infra MCP 도구
 *
 * 이 파일의 역할:
 * - "init-infra"라는 MCP 도구를 등록합니다.
 * - Claude Code가 "인프라 초기화해줘"라고 하면 이 도구가 호출됩니다.
 * - S3, IAM, Firehose, Athena 리소스를 한 번에 생성합니다.
 *
 * 멱등성(Idempotency):
 * - 이미 존재하는 리소스는 스킵합니다.
 * - 두 번 실행해도 에러 없이 동작합니다.
 * - 각 리소스마다 "이미 존재하는가?" 확인 -> 없으면 생성 패턴을 사용합니다.
 *
 * Glue SDK 제거:
 * - 이전에는 Glue SDK로 테이블을 생성했지만, Athena DDL(CREATE EXTERNAL TABLE)로
 *   직접 만들면 Glue SDK가 불필요합니다.
 * - Athena에서 CREATE TABLE하면 내부적으로 Glue Data Catalog에 등록됩니다.
 *
 * AWS SDK v3 사용 이유:
 * - TypeScript 네이티브 지원 (타입이 완벽)
 * - 모듈별로 분리되어 필요한 서비스만 import (번들 크기 최소화)
 * - v2는 레거시이며 AWS가 v3 사용을 권장합니다.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../config.js";

// =============================================================
// AWS SDK v3 클라이언트 import
// =============================================================
// AWS SDK v3는 서비스별로 패키지가 분리되어 있습니다.
// 각 서비스에서 필요한 Client와 Command만 import합니다.
// 왜 Command 패턴인가? SDK v3는 client.send(command) 패턴을 사용합니다.
// 이렇게 하면 각 API 호출이 독립적이고 타입이 정확합니다.

import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  type CreateBucketCommandInput,
  type LifecycleRule,
} from "@aws-sdk/client-s3";

import {
  IAMClient,
  CreateRoleCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";

import {
  FirehoseClient,
  CreateDeliveryStreamCommand,
  DescribeDeliveryStreamCommand,
} from "@aws-sdk/client-firehose";

// Lambda SDK: Lambda 변환 함수 생성에 사용합니다.
// CloudWatch Logs -> Firehose로 전달되는 gzip 데이터를 해제하고
// logEvents를 개별 레코드로 분리하는 Lambda 함수를 생성합니다.
import {
  LambdaClient,
  CreateFunctionCommand,
  GetFunctionCommand,
  type Runtime,
} from "@aws-sdk/client-lambda";

import {
  AthenaClient,
  CreateWorkGroupCommand,
  GetWorkGroupCommand,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
} from "@aws-sdk/client-athena";

// =============================================================
// 타입 정의
// =============================================================

/**
 * 각 리소스의 생성 결과를 나타내는 타입
 * - created: 새로 생성됨
 * - exists: 이미 존재하여 스킵됨
 * - failed: 생성 실패
 */
type ResourceStatus = "created" | "exists" | "failed";

/**
 * 하나의 리소스 결과를 나타내는 인터페이스
 */
interface ResourceResult {
  name: string;
  status: ResourceStatus;
  detail: string;
}

// =============================================================
// 상수 정의
// =============================================================

/** Athena/Glue 데이터베이스 이름. Glue는 하이픈을 허용하지 않으므로 언더스코어를 사용합니다. */
const DATABASE_NAME = "s3_logwatch";

/** Athena/Glue 테이블 이름 */
const TABLE_NAME = "logs";

/** Firehose용 IAM 역할 이름 */
const FIREHOSE_ROLE_NAME = "s3-logwatch-firehose-role";

/** Lambda 변환 함수 이름 */
const LAMBDA_FUNCTION_NAME = "s3-logwatch-transformer";

/** Lambda용 IAM 역할 이름 */
const LAMBDA_ROLE_NAME = "s3-logwatch-lambda-role";

// =============================================================
// 입력 파라미터 스키마
// =============================================================

/**
 * region 파라미터:
 * - AWS 리전을 지정합니다.
 * - 기본값: us-east-1
 * - 왜 optional인가? 대부분의 사용자는 기본 리전을 사용하므로 입력을 줄여줍니다.
 */
const regionSchema = z
  .string()
  .optional()
  .describe(
    'AWS region to create resources in (default: "us-east-1"). Example: "ap-northeast-2" for Seoul.'
  );

// =============================================================
// 도구 등록 함수
// =============================================================

/**
 * init-infra 도구를 MCP 서버에 등록합니다.
 *
 * registerConfigTool(config.ts)과 동일한 패턴:
 * 1. server.tool()로 도구를 등록
 * 2. 핸들러에서 비즈니스 로직 실행
 * 3. 결과를 MCP CallToolResult 형태로 반환
 */
export function registerInitTool(server: McpServer): void {
  server.tool(
    // 도구 이름: Claude Code가 이 이름으로 도구를 호출합니다
    "init-infra",

    // 도구 설명: Claude가 "인프라 초기화해줘" 같은 요청을 이 도구에 매핑하는 데 사용
    "Initialize all AWS infrastructure for s3-logwatch. Creates S3 bucket, Athena database/table (via DDL), IAM role, Kinesis Data Firehose delivery stream, and Athena workgroup. Safe to run multiple times (idempotent).",

    // 입력 파라미터 스키마
    {
      region: regionSchema,
    },

    // 핸들러 함수
    async (args) => {
      try {
        const results = await initInfra(args.region);
        return formatResults(results);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
        return {
          content: [
            {
              type: "text" as const,
              text: `인프라 초기화 실패: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

// =============================================================
// Athena DDL 헬퍼 함수
// =============================================================

/**
 * Athena를 통해 DDL(SQL)을 실행하고 완료될 때까지 폴링합니다.
 *
 * 왜 폴링이 필요한가?
 * - Athena 쿼리는 비동기적으로 실행됩니다.
 * - StartQueryExecution으로 쿼리를 제출하면 QueryExecutionId를 받습니다.
 * - GetQueryExecution으로 상태를 확인하여 SUCCEEDED/FAILED/CANCELLED를 기다립니다.
 *
 * @param athena - AthenaClient 인스턴스
 * @param sql - 실행할 DDL SQL 문자열
 * @param workgroup - Athena 워크그룹 이름
 * @param outputLocation - 쿼리 결과 저장 S3 경로
 */
export async function executeAthenaDDL(
  athena: AthenaClient,
  sql: string,
  workgroup: string,
  outputLocation: string
): Promise<void> {
  // DDL 쿼리를 Athena에 제출합니다
  const start = await athena.send(new StartQueryExecutionCommand({
    QueryString: sql,
    WorkGroup: workgroup,
    ResultConfiguration: { OutputLocation: outputLocation },
  }));

  const queryId = start.QueryExecutionId!;

  // 쿼리 완료까지 1초 간격으로 폴링합니다
  while (true) {
    await new Promise(r => setTimeout(r, 1000));
    const status = await athena.send(new GetQueryExecutionCommand({
      QueryExecutionId: queryId,
    }));
    const state = status.QueryExecution?.Status?.State;
    if (state === "SUCCEEDED") break;
    if (state === "FAILED" || state === "CANCELLED") {
      throw new Error(`DDL 실패: ${status.QueryExecution?.Status?.StateChangeReason}`);
    }
  }
}

/**
 * config를 받아서 CREATE EXTERNAL TABLE DDL 문자열을 생성합니다.
 *
 * Partition Projection 설명:
 * - Athena가 파티션을 자동 인식하도록 TBLPROPERTIES에 설정합니다.
 * - MSCK REPAIR TABLE을 실행하지 않아도 새 파티션을 인식합니다.
 * - domain: config.domains에서 동적으로 enum 값을 생성합니다.
 * - year/month/day: 정수 범위로 날짜 파티션을 정의합니다.
 *
 * @param config - 앱 설정 (s3, domains 등)
 * @returns CREATE EXTERNAL TABLE IF NOT EXISTS DDL 문자열
 */
export function buildCreateTableDDL(config: ReturnType<typeof loadConfig>): string {
  // config.domains에서 도메인 이름 목록을 추출하여 쉼표로 연결
  const domainValues = config.domains.map(d => d.name).join(",");

  // format에 따라 SerDe를 결정합니다
  // - json: JsonSerDe (JSON Lines 포맷)
  // - parquet: ParquetHiveSerDe (Parquet 컬럼형 포맷)
  const isParquet = config.firehose.format === "parquet";
  const serdeLine = isParquet
    ? "ROW FORMAT SERDE 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe'"
    : "ROW FORMAT SERDE 'org.openx.data.jsonserde.JsonSerDe'";
  const serdeProps = isParquet
    ? ""
    : "\n    WITH SERDEPROPERTIES ('case.insensitive' = 'true')";
  const storedAs = isParquet
    ? "\n    STORED AS PARQUET"
    : "";

  return `
    CREATE EXTERNAL TABLE IF NOT EXISTS ${DATABASE_NAME}.${TABLE_NAME} (
      timestamp string,
      level string,
      service string,
      message string,
      trace_id string
    )
    PARTITIONED BY (domain string, year string, month string, day string)
    ${serdeLine}${serdeProps}${storedAs}
    LOCATION 's3://${config.s3.bucket}/${config.s3.base_prefix}'
    TBLPROPERTIES (
      'projection.enabled' = 'true',
      'projection.domain.type' = 'enum',
      'projection.domain.values' = '${domainValues}',
      'projection.year.type' = 'integer',
      'projection.year.range' = '2024,2030',
      'projection.month.type' = 'integer',
      'projection.month.range' = '1,12',
      'projection.month.digits' = '2',
      'projection.day.type' = 'integer',
      'projection.day.range' = '1,31',
      'projection.day.digits' = '2',
      'storage.location.template' = 's3://${config.s3.bucket}/${config.s3.base_prefix}\${domain}/\${year}/\${month}/\${day}/'
    )
  `;
}

// =============================================================
// 메인 초기화 로직
// =============================================================

/**
 * 모든 AWS 리소스를 순서대로 생성합니다.
 *
 * 순서가 중요한 이유:
 * 1. S3 버킷: Firehose가 로그를 저장할 목적지
 * 2. Athena 워크그룹: DDL 실행에 필요 (워크그룹이 있어야 쿼리 실행 가능)
 * 3. Athena DDL로 DB/테이블 생성: Glue Data Catalog에 자동 등록됨
 * 4. IAM 역할: Firehose가 S3에 쓰고 Glue를 읽을 권한
 * 5. Firehose: 위 4개가 다 준비된 후에야 생성 가능
 *
 * @param region - AWS 리전 (기본값: us-east-1)
 * @returns 각 리소스별 생성 결과 배열
 */
async function initInfra(region?: string): Promise<ResourceResult[]> {
  const resolvedRegion = region ?? "us-east-1";
  const config = loadConfig();
  const results: ResourceResult[] = [];

  // AWS SDK 클라이언트 생성
  // 왜 매번 생성하나? MCP 도구는 호출 간에 상태를 유지하지 않습니다.
  // 리전이 호출마다 다를 수 있으므로 클라이언트도 매번 새로 만듭니다.
  const s3 = new S3Client({ region: resolvedRegion });
  const iam = new IAMClient({ region: resolvedRegion });
  const firehose = new FirehoseClient({ region: resolvedRegion });
  const athena = new AthenaClient({ region: resolvedRegion });

  // --- (a) S3 버킷 생성 ---
  results.push(await createS3Bucket(s3, config.s3.bucket, resolvedRegion));

  // --- (a-2) S3 Lifecycle Rule 설정 ---
  // retention_days, glacier_transition_days 설정에 따라 객체 수명 주기를 관리합니다.
  results.push(await createS3Lifecycle(s3, config));

  // --- (b) Athena 워크그룹 생성 (DDL 실행 전에 워크그룹이 필요) ---
  results.push(
    await createAthenaWorkgroup(athena, config)
  );

  // --- (c) Athena DDL로 데이터베이스 + 테이블 생성 ---
  // Glue SDK 대신 Athena DDL을 사용합니다.
  // CREATE DATABASE/TABLE IF NOT EXISTS로 멱등성을 보장합니다.
  results.push(
    await createAthenaTable(athena, config)
  );

  // --- (d) IAM 역할 생성 ---
  const accountId = await getAccountIdFromBucketArn(config.s3.bucket, resolvedRegion);
  results.push(
    await createFirehoseIamRole(iam, config.s3.bucket, resolvedRegion, accountId)
  );

  // --- (d-2) Lambda용 IAM 역할 생성 ---
  // Lambda 변환 함수가 CloudWatch Logs를 쓰기 위한 역할입니다.
  const lambda = new LambdaClient({ region: resolvedRegion });
  results.push(
    await createLambdaIamRole(iam, resolvedRegion)
  );

  // --- (d-3) Lambda 변환 함수 생성 ---
  // CloudWatch Logs의 gzip 데이터를 해제하고 logEvents를 분리합니다.
  results.push(
    await createLambdaFunction(lambda, iam, config, resolvedRegion)
  );

  // --- (e) Firehose delivery stream 생성 ---
  // IAM 역할 생성 직후에는 AWS 내부 전파 지연이 있을 수 있습니다.
  // 실패하면 "잠시 후 다시 시도하세요" 안내를 포함합니다.
  // Lambda 함수 ARN을 조회하여 Firehose ProcessingConfiguration에 연결합니다.
  let lambdaArn: string | undefined;
  try {
    const lambdaInfo = await lambda.send(
      new GetFunctionCommand({ FunctionName: LAMBDA_FUNCTION_NAME })
    );
    lambdaArn = lambdaInfo.Configuration?.FunctionArn;
  } catch {
    // Lambda 함수가 없을 수 있음 (생성 실패 등) - Firehose는 Lambda 없이도 생성 가능
  }
  results.push(
    await createFirehoseStream(firehose, config, resolvedRegion, accountId, lambdaArn)
  );

  return results;
}

// =============================================================
// (a) S3 버킷 생성
// =============================================================

/**
 * S3 버킷을 생성합니다.
 *
 * 멱등성 처리:
 * - HeadBucket으로 존재 여부 확인
 * - 존재하면 스킵, 없으면 생성
 *
 * us-east-1 특이사항:
 * - CreateBucket에서 LocationConstraint를 지정하면 안 됩니다.
 * - 다른 리전에서는 반드시 지정해야 합니다.
 * - AWS의 오래된 설계 때문인데, us-east-1이 기본 리전이라 생략합니다.
 */
async function createS3Bucket(
  s3: S3Client,
  bucketName: string,
  region: string
): Promise<ResourceResult> {
  try {
    // 버킷 존재 여부 확인 (HeadBucket은 버킷이 없으면 에러를 던집니다)
    await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
    return {
      name: "S3 Bucket",
      status: "exists",
      detail: `s3://${bucketName} (이미 존재)`,
    };
  } catch (headError: unknown) {
    // HeadBucket 에러 중 "NotFound" 또는 "404"만 "없음"으로 처리
    // 권한 부족 등 다른 에러는 그대로 전파합니다
    const errorName = (headError as { name?: string })?.name ?? "";
    if (errorName !== "NotFound" && errorName !== "404") {
      // 404가 아닌 에러(예: 권한 부족)는 그대로 실패 처리
      const message =
        headError instanceof Error ? headError.message : String(headError);
      // "NoSuchBucket"도 버킷이 없다는 의미이므로 통과시킵니다
      if (errorName !== "NoSuchBucket") {
        return {
          name: "S3 Bucket",
          status: "failed",
          detail: `s3://${bucketName} - ${message}`,
        };
      }
    }
  }

  // 버킷이 없으므로 생성합니다
  try {
    const input: CreateBucketCommandInput = { Bucket: bucketName };

    // us-east-1이 아닌 리전에서는 LocationConstraint를 지정해야 합니다
    if (region !== "us-east-1") {
      input.CreateBucketConfiguration = {
        LocationConstraint: region as CreateBucketCommandInput["CreateBucketConfiguration"] extends
          | { LocationConstraint?: infer L }
          | undefined
          ? L
          : never,
      };
    }

    await s3.send(new CreateBucketCommand(input));
    return {
      name: "S3 Bucket",
      status: "created",
      detail: `s3://${bucketName} (리전: ${region})`,
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
// (a-2) S3 Lifecycle Rule 설정
// =============================================================

/**
 * S3 버킷에 Lifecycle Rule을 설정합니다.
 *
 * Lifecycle Rule이란?
 * - S3 객체의 수명 주기를 자동으로 관리합니다.
 * - retention_days 후 객체를 삭제합니다.
 * - glacier_transition_days가 설정되면 해당 일수 후 Glacier 스토리지 클래스로 전환합니다.
 *   (Glacier는 저비용 장기 보관용 스토리지입니다)
 *
 * 멱등성:
 * - PutBucketLifecycleConfiguration은 기존 설정을 덮어씁니다.
 * - retention_days가 설정되지 않으면 Lifecycle Rule을 생성하지 않습니다.
 */
async function createS3Lifecycle(
  s3: S3Client,
  config: ReturnType<typeof loadConfig>
): Promise<ResourceResult> {
  const bucketName = config.s3.bucket;
  const retentionDays = config.s3.retention_days;
  const glacierDays = config.s3.glacier_transition_days;

  // retention_days가 설정되지 않으면 Lifecycle Rule을 생성하지 않습니다
  if (retentionDays == null) {
    return {
      name: "S3 Lifecycle",
      status: "exists",
      detail: `s3://${bucketName} - retention_days 미설정, Lifecycle Rule 스킵`,
    };
  }

  try {
    const rules: LifecycleRule[] = [];

    // Glacier 전환 규칙: glacier_transition_days가 설정된 경우에만 추가
    if (glacierDays != null) {
      rules.push({
        ID: "s3-logwatch-glacier-transition",
        Status: "Enabled",
        Filter: {
          Prefix: config.s3.base_prefix,
        },
        Transitions: [
          {
            Days: glacierDays,
            StorageClass: "GLACIER",
          },
        ],
      });
    }

    // 만료(삭제) 규칙: retention_days 후 객체 삭제
    rules.push({
      ID: "s3-logwatch-expiration",
      Status: "Enabled",
      Filter: {
        Prefix: config.s3.base_prefix,
      },
      Expiration: {
        Days: retentionDays,
      },
    });

    await s3.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: bucketName,
        LifecycleConfiguration: {
          Rules: rules,
        },
      })
    );

    const details: string[] = [`${retentionDays}일 후 삭제`];
    if (glacierDays != null) {
      details.unshift(`${glacierDays}일 후 Glacier 전환`);
    }

    return {
      name: "S3 Lifecycle",
      status: "created",
      detail: `s3://${bucketName} (${details.join(", ")})`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "S3 Lifecycle",
      status: "failed",
      detail: `s3://${bucketName} - ${message}`,
    };
  }
}

// =============================================================
// (b) Athena 워크그룹 생성
// =============================================================

/**
 * Athena 워크그룹을 생성합니다.
 *
 * 워크그룹이란?
 * - Athena 쿼리 실행 환경을 격리하는 단위입니다.
 * - 쿼리 결과 저장 위치, 스캔량 제한 등을 워크그룹 단위로 설정합니다.
 * - s3-logwatch 전용 워크그룹을 만들어 다른 Athena 사용과 분리합니다.
 *
 * 왜 DDL 실행 전에 워크그룹을 먼저 만드나?
 * - CREATE DATABASE/TABLE DDL을 실행하려면 워크그룹이 필요합니다.
 * - 워크그룹에 ResultConfiguration(결과 저장 위치)이 설정되어야 DDL 실행이 가능합니다.
 */
async function createAthenaWorkgroup(
  athena: AthenaClient,
  config: ReturnType<typeof loadConfig>
): Promise<ResourceResult> {
  const workgroupName = config.athena.workgroup;

  // 존재 여부 확인
  try {
    await athena.send(
      new GetWorkGroupCommand({ WorkGroup: workgroupName })
    );
    return {
      name: "Athena Workgroup",
      status: "exists",
      detail: `${workgroupName} (이미 존재)`,
    };
  } catch (error: unknown) {
    const errorName = (error as { name?: string })?.name ?? "";
    if (errorName !== "InvalidRequestException") {
      const message = error instanceof Error ? error.message : String(error);
      return {
        name: "Athena Workgroup",
        status: "failed",
        detail: `${workgroupName} - ${message}`,
      };
    }
  }

  try {
    await athena.send(
      new CreateWorkGroupCommand({
        Name: workgroupName,
        Description:
          "s3-logwatch: S3 로그 분석용 Athena 워크그룹. 쿼리 결과는 S3에 저장됩니다.",
        Configuration: {
          // 쿼리 결과가 저장되는 S3 위치
          ResultConfiguration: {
            OutputLocation: config.athena.output_location,
          },
          // 쿼리 실행 시 개별 설정을 워크그룹 설정으로 강제
          // 사용자가 실수로 다른 위치에 결과를 저장하는 것을 방지합니다
          EnforceWorkGroupConfiguration: true,
          // CloudWatch 메트릭 게시 (쿼리 성능 모니터링용)
          PublishCloudWatchMetricsEnabled: true,
        },
      })
    );
    return {
      name: "Athena Workgroup",
      status: "created",
      detail: `${workgroupName} (결과 저장: ${config.athena.output_location})`,
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
// (c) Athena DDL로 데이터베이스 + 테이블 생성
// =============================================================

/**
 * Athena DDL을 사용하여 데이터베이스와 테이블을 생성합니다.
 *
 * Glue SDK 대신 Athena DDL을 사용하는 이유:
 * - CREATE EXTERNAL TABLE을 실행하면 내부적으로 Glue Data Catalog에 등록됩니다.
 * - Glue SDK 의존성을 제거하여 번들 크기를 줄이고 코드를 단순화합니다.
 * - IF NOT EXISTS를 사용하여 멱등성을 보장합니다.
 *
 * 실행 순서:
 * 1. CREATE DATABASE IF NOT EXISTS - 데이터베이스 생성
 * 2. CREATE EXTERNAL TABLE IF NOT EXISTS - 테이블 생성 (Partition Projection 포함)
 */
async function createAthenaTable(
  athena: AthenaClient,
  config: ReturnType<typeof loadConfig>
): Promise<ResourceResult> {
  const workgroup = config.athena.workgroup;
  const outputLocation = config.athena.output_location;

  try {
    // 1단계: 데이터베이스 생성
    // CREATE DATABASE IF NOT EXISTS로 이미 존재하면 무시됩니다
    await executeAthenaDDL(
      athena,
      `CREATE DATABASE IF NOT EXISTS ${DATABASE_NAME}`,
      workgroup,
      outputLocation
    );

    // 2단계: 테이블 생성
    // CREATE EXTERNAL TABLE IF NOT EXISTS로 이미 존재하면 무시됩니다
    // Partition Projection TBLPROPERTIES가 포함되어 MSCK REPAIR TABLE 없이 파티션을 인식합니다
    const createTableDDL = buildCreateTableDDL(config);
    await executeAthenaDDL(athena, createTableDDL, workgroup, outputLocation);

    return {
      name: "Athena Table (via DDL)",
      status: "created",
      detail: `${DATABASE_NAME}.${TABLE_NAME} (Athena DDL로 생성, Glue Data Catalog에 자동 등록)`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "Athena Table (via DDL)",
      status: "failed",
      detail: `${DATABASE_NAME}.${TABLE_NAME} - ${message}`,
    };
  }
}

// =============================================================
// (d) IAM 역할 생성
// =============================================================

/**
 * AWS 계정 ID를 가져오기 위한 헬퍼
 *
 * 왜 필요한가?
 * - IAM 정책에서 S3 버킷 ARN, Glue 리소스 ARN을 지정할 때 계정 ID가 필요합니다.
 * - STS GetCallerIdentity를 쓸 수도 있지만, 추가 패키지 의존성을 피하기 위해
 *   IAM 정책에서는 와일드카드(*)를 사용하고 리소스 ARN으로 범위를 제한합니다.
 *
 * accountId가 비어있을 수 있으므로 Glue ARN에서 와일드카드를 사용합니다.
 */
async function getAccountIdFromBucketArn(
  _bucketName: string,
  _region: string
): Promise<string> {
  // STS 의존성을 추가하지 않기 위해 빈 문자열을 반환합니다.
  // IAM 정책에서 계정 ID가 필요한 Glue ARN은 와일드카드(*)를 사용합니다.
  return "";
}

/**
 * Firehose용 IAM 역할을 생성합니다.
 *
 * IAM 역할이란?
 * - AWS 서비스가 다른 AWS 서비스에 접근할 때 필요한 "신분증"입니다.
 * - Firehose가 S3에 파일을 쓰려면 "S3에 쓸 수 있는 역할"이 필요합니다.
 *
 * Trust Policy (신뢰 정책):
 * - "누가 이 역할을 사용할 수 있는가?"를 정의합니다.
 * - firehose.amazonaws.com만 이 역할을 사용할 수 있도록 합니다.
 *
 * Inline Policy (인라인 정책):
 * - "이 역할로 무엇을 할 수 있는가?"를 정의합니다.
 * - S3: PutObject, GetObject, ListBucket (로그 파일 쓰기)
 * - Glue: GetTable, GetDatabase (Athena DDL로 생성된 Glue 카탈로그 조회)
 */
async function createFirehoseIamRole(
  iam: IAMClient,
  bucketName: string,
  region: string,
  _accountId: string
): Promise<ResourceResult> {
  // 역할 존재 여부 확인
  try {
    await iam.send(new GetRoleCommand({ RoleName: FIREHOSE_ROLE_NAME }));
    return {
      name: "IAM Role",
      status: "exists",
      detail: `${FIREHOSE_ROLE_NAME} (이미 존재)`,
    };
  } catch (error: unknown) {
    const errorName = (error as { name?: string })?.name ?? "";
    if (errorName !== "NoSuchEntityException") {
      const message = error instanceof Error ? error.message : String(error);
      return {
        name: "IAM Role",
        status: "failed",
        detail: `${FIREHOSE_ROLE_NAME} - ${message}`,
      };
    }
  }

  try {
    // Trust Policy: Firehose 서비스만 이 역할을 assume할 수 있습니다
    const trustPolicy = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: {
            Service: "firehose.amazonaws.com",
          },
          Action: "sts:AssumeRole",
        },
      ],
    };

    // 역할 생성
    await iam.send(
      new CreateRoleCommand({
        RoleName: FIREHOSE_ROLE_NAME,
        AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
        Description:
          "s3-logwatch: Firehose가 S3에 로그를 쓰고 Glue 스키마를 조회하기 위한 역할",
      })
    );

    // Inline Policy: S3 쓰기 + Glue 읽기 권한
    // 왜 Managed Policy가 아닌 Inline Policy인가?
    // - 이 역할에만 필요한 최소 권한을 정확히 정의하기 위해서입니다.
    // - Managed Policy는 범용적이어서 불필요한 권한이 포함될 수 있습니다.
    // 참고: Glue 권한은 여전히 필요합니다 (Athena DDL로 생성해도 Glue Data Catalog를 참조하므로)
    const inlinePolicy = {
      Version: "2012-10-17",
      Statement: [
        {
          // S3 버킷에 로그 파일을 쓰는 권한
          Sid: "S3Access",
          Effect: "Allow",
          Action: [
            "s3:PutObject",
            "s3:GetObject",
            "s3:ListBucket",
            "s3:GetBucketLocation",
          ],
          Resource: [
            `arn:aws:s3:::${bucketName}`,
            `arn:aws:s3:::${bucketName}/*`,
          ],
        },
        {
          // Glue 테이블 스키마를 조회하는 권한
          // Athena DDL로 테이블을 만들어도 Glue Data Catalog에 등록되므로
          // Firehose가 스키마를 참조할 때 Glue 읽기 권한이 필요합니다
          Sid: "GlueAccess",
          Effect: "Allow",
          Action: [
            "glue:GetTable",
            "glue:GetTableVersion",
            "glue:GetTableVersions",
            "glue:GetDatabase",
          ],
          // Glue ARN은 계정 ID가 필요하지만, 와일드카드로 처리합니다
          // 보안상 리소스 이름으로 범위를 충분히 제한합니다
          Resource: [
            `arn:aws:glue:${region}:*:catalog`,
            `arn:aws:glue:${region}:*:database/${DATABASE_NAME}`,
            `arn:aws:glue:${region}:*:table/${DATABASE_NAME}/${TABLE_NAME}`,
          ],
        },
      ],
    };

    await iam.send(
      new PutRolePolicyCommand({
        RoleName: FIREHOSE_ROLE_NAME,
        PolicyName: "s3-logwatch-firehose-policy",
        PolicyDocument: JSON.stringify(inlinePolicy),
      })
    );

    return {
      name: "IAM Role",
      status: "created",
      detail: `${FIREHOSE_ROLE_NAME} (S3 PutObject + Glue GetTable 권한)`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "IAM Role",
      status: "failed",
      detail: `${FIREHOSE_ROLE_NAME} - ${message}`,
    };
  }
}

// =============================================================
// (d-2) Lambda용 IAM 역할 생성
// =============================================================

/**
 * Lambda 변환 함수용 IAM 역할을 생성합니다.
 *
 * Trust Policy: lambda.amazonaws.com만 이 역할을 assume할 수 있습니다.
 * 권한: CloudWatch Logs 쓰기 (Lambda 실행 로그)
 */
async function createLambdaIamRole(
  iam: IAMClient,
  _region: string
): Promise<ResourceResult> {
  try {
    await iam.send(new GetRoleCommand({ RoleName: LAMBDA_ROLE_NAME }));
    return {
      name: "Lambda IAM Role",
      status: "exists",
      detail: `${LAMBDA_ROLE_NAME} (이미 존재)`,
    };
  } catch (error: unknown) {
    const errorName = (error as { name?: string })?.name ?? "";
    if (errorName !== "NoSuchEntityException") {
      const message = error instanceof Error ? error.message : String(error);
      return {
        name: "Lambda IAM Role",
        status: "failed",
        detail: `${LAMBDA_ROLE_NAME} - ${message}`,
      };
    }
  }

  try {
    const trustPolicy = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "lambda.amazonaws.com" },
          Action: "sts:AssumeRole",
        },
      ],
    };

    await iam.send(
      new CreateRoleCommand({
        RoleName: LAMBDA_ROLE_NAME,
        AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
        Description:
          "s3-logwatch: Lambda 변환 함수가 CloudWatch Logs에 실행 로그를 쓰기 위한 역할",
      })
    );

    const inlinePolicy = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "CloudWatchLogsAccess",
          Effect: "Allow",
          Action: [
            "logs:CreateLogGroup",
            "logs:CreateLogStream",
            "logs:PutLogEvents",
          ],
          Resource: "arn:aws:logs:*:*:*",
        },
      ],
    };

    await iam.send(
      new PutRolePolicyCommand({
        RoleName: LAMBDA_ROLE_NAME,
        PolicyName: "s3-logwatch-lambda-policy",
        PolicyDocument: JSON.stringify(inlinePolicy),
      })
    );

    return {
      name: "Lambda IAM Role",
      status: "created",
      detail: `${LAMBDA_ROLE_NAME} (CloudWatch Logs 쓰기 권한)`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "Lambda IAM Role",
      status: "failed",
      detail: `${LAMBDA_ROLE_NAME} - ${message}`,
    };
  }
}

// =============================================================
// (d-3) Lambda 변환 함수 생성
// =============================================================

/**
 * Firehose 데이터 변환용 Lambda 함수를 생성합니다.
 *
 * CloudWatch Logs에서 전달된 gzip 데이터를 해제하고,
 * logEvents 배열을 개별 레코드로 분리하며,
 * logGroup -> domain 매핑을 적용합니다.
 *
 * 환경변수 DOMAIN_MAPPING:
 * - config.connections에서 logGroup -> domain 매핑을 생성합니다.
 * - 예: {"/ecs/payment-api":"payment","/ecs/user-api":"user"}
 */
async function createLambdaFunction(
  lambda: LambdaClient,
  iam: IAMClient,
  config: ReturnType<typeof loadConfig>,
  _region: string
): Promise<ResourceResult> {
  try {
    await lambda.send(
      new GetFunctionCommand({ FunctionName: LAMBDA_FUNCTION_NAME })
    );
    return {
      name: "Lambda Function",
      status: "exists",
      detail: `${LAMBDA_FUNCTION_NAME} (이미 존재)`,
    };
  } catch (error: unknown) {
    const errorName = (error as { name?: string })?.name ?? "";
    if (errorName !== "ResourceNotFoundException") {
      const message = error instanceof Error ? error.message : String(error);
      return {
        name: "Lambda Function",
        status: "failed",
        detail: `${LAMBDA_FUNCTION_NAME} - ${message}`,
      };
    }
  }

  try {
    // Lambda IAM 역할 ARN 조회
    const roleResponse = await iam.send(
      new GetRoleCommand({ RoleName: LAMBDA_ROLE_NAME })
    );
    const roleArn = roleResponse.Role?.Arn;

    if (!roleArn) {
      return {
        name: "Lambda Function",
        status: "failed",
        detail: `${LAMBDA_FUNCTION_NAME} - Lambda IAM 역할 ARN을 가져올 수 없습니다.`,
      };
    }

    // config.connections에서 logGroup -> domain 매핑 생성
    const domainMapping: Record<string, string> = {};
    for (const conn of config.connections) {
      domainMapping[conn.log_group] = conn.domain;
    }

    // 플레이스홀더 코드 (실제 변환 로직은 src/lambda/transformer.ts에 있음)
    const placeholderCode = Buffer.from(
      'exports.handler = async (event) => { return { records: event.records.map(r => ({ recordId: r.recordId, result: "Ok", data: r.data })) }; };'
    );

    const runtime: Runtime = "nodejs20.x" as Runtime;

    await lambda.send(
      new CreateFunctionCommand({
        FunctionName: LAMBDA_FUNCTION_NAME,
        Runtime: runtime,
        Role: roleArn,
        Handler: "index.handler",
        Code: { ZipFile: placeholderCode },
        Description:
          "s3-logwatch: CloudWatch Logs gzip 해제 + logEvents 분리 + domain 매핑",
        Timeout: 60,
        MemorySize: 128,
        Environment: {
          Variables: {
            DOMAIN_MAPPING: JSON.stringify(domainMapping),
          },
        },
      })
    );

    return {
      name: "Lambda Function",
      status: "created",
      detail: `${LAMBDA_FUNCTION_NAME} (domain 매핑: ${Object.keys(domainMapping).length}개 로그 그룹)`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "Lambda Function",
      status: "failed",
      detail: `${LAMBDA_FUNCTION_NAME} - ${message}`,
    };
  }
}

// =============================================================
// (e) Firehose Delivery Stream 생성
// =============================================================

/**
 * Kinesis Data Firehose delivery stream을 생성합니다.
 *
 * Firehose란?
 * - AWS의 스트리밍 데이터 전송 서비스입니다.
 * - CloudWatch Logs에서 받은 JSON 로그를 S3에 저장합니다.
 * - 버퍼링: 일정 시간(buffer_interval) 또는 크기(buffer_size)가 차면 S3에 씁니다.
 *
 * ExtendedS3DestinationConfiguration:
 * - Firehose의 S3 출력 설정입니다.
 * - Prefix: Hive 파티셔닝 경로 (domain=payment/...)
 * - 동적 파티셔닝: JQ로 domain 필드를 추출하여 S3 경로에 사용
 */
async function createFirehoseStream(
  firehose: FirehoseClient,
  config: ReturnType<typeof loadConfig>,
  region: string,
  _accountId: string,
  lambdaArn?: string
): Promise<ResourceResult> {
  const streamName = config.firehose.delivery_stream;

  // 존재 여부 확인
  try {
    await firehose.send(
      new DescribeDeliveryStreamCommand({
        DeliveryStreamName: streamName,
      })
    );
    return {
      name: "Firehose Stream",
      status: "exists",
      detail: `${streamName} (이미 존재)`,
    };
  } catch (error: unknown) {
    const errorName = (error as { name?: string })?.name ?? "";
    if (errorName !== "ResourceNotFoundException") {
      const message = error instanceof Error ? error.message : String(error);
      return {
        name: "Firehose Stream",
        status: "failed",
        detail: `${streamName} - ${message}`,
      };
    }
  }

  try {
    // IAM 역할의 ARN을 조회합니다
    // 왜 다시 조회하나? 역할이 이미 존재했을 수도, 방금 생성했을 수도 있으므로
    // 항상 최신 ARN을 가져옵니다.
    const roleResponse = await new IAMClient({ region }).send(
      new GetRoleCommand({ RoleName: FIREHOSE_ROLE_NAME })
    );
    const roleArn = roleResponse.Role?.Arn;

    if (!roleArn) {
      return {
        name: "Firehose Stream",
        status: "failed",
        detail: `${streamName} - IAM 역할 ARN을 가져올 수 없습니다. init-infra를 다시 실행해주세요.`,
      };
    }

    const bucketArn = `arn:aws:s3:::${config.s3.bucket}`;
    const isParquet = config.firehose.format === "parquet";

    // 동적 파티셔닝 Prefix 설명:
    // !{partitionKeyFromQuery:domain}: JQ로 추출한 domain 필드값 (예: "user", "order")
    // !{timestamp:yyyy}: 전송 시간의 연도
    // !{timestamp:MM}: 전송 시간의 월
    // !{timestamp:dd}: 전송 시간의 일
    const prefix =
      `${config.s3.base_prefix}` +
      `!{partitionKeyFromQuery:domain}/` +
      `!{timestamp:yyyy}/` +
      `!{timestamp:MM}/` +
      `!{timestamp:dd}/`;

    // Parquet DataFormatConversion 설정
    // Firehose가 JSON 입력을 Parquet로 변환하여 S3에 저장합니다.
    // Glue Data Catalog의 테이블 스키마를 참조하여 컬럼 타입을 결정합니다.
    const dataFormatConversion = isParquet
      ? {
          Enabled: true,
          SchemaConfiguration: {
            RoleARN: roleArn,
            DatabaseName: DATABASE_NAME,
            TableName: TABLE_NAME,
            Region: region,
          },
          InputFormatConfiguration: {
            Deserializer: {
              OpenXJsonSerDe: {},
            },
          },
          OutputFormatConfiguration: {
            Serializer: {
              ParquetSerDe: {
                Compression: "SNAPPY" as const,
              },
            },
          },
        }
      : undefined;

    await firehose.send(
      new CreateDeliveryStreamCommand({
        DeliveryStreamName: streamName,
        DeliveryStreamType: "DirectPut",
        ExtendedS3DestinationConfiguration: {
          // IAM 역할: Firehose가 S3와 Glue에 접근하기 위한 권한
          RoleARN: roleArn,
          // S3 버킷 ARN
          BucketARN: bucketArn,
          // Hive 파티셔닝 경로
          Prefix: prefix,
          // 에러가 발생한 레코드가 저장되는 경로
          ErrorOutputPrefix: `${config.s3.base_prefix}errors/`,
          // 버퍼링 설정: 이 조건 중 하나라도 충족되면 S3에 파일을 씁니다
          BufferingHints: {
            IntervalInSeconds: config.firehose.buffer_interval,
            // Dynamic Partitioning 사용 시 최소 64MB 필요
            SizeInMBs: Math.max(config.firehose.buffer_size, 64),
          },
          // 압축: JSON은 UNCOMPRESSED, Parquet은 DataFormatConversion이 Snappy 압축을 처리
          CompressionFormat: "UNCOMPRESSED",
          // 동적 파티셔닝: 로그 필드값을 기반으로 S3 경로를 결정합니다
          DynamicPartitioningConfiguration: {
            Enabled: true,
          },
          // Parquet 포맷인 경우 DataFormatConversion 활성화
          ...(dataFormatConversion
            ? { DataFormatConversionConfiguration: dataFormatConversion }
            : {}),
          // 프로세서 목록: Lambda 변환 + JQ 메타데이터 추출 + 줄바꿈 구분자
          // Lambda: CloudWatch gzip 해제 + logEvents 분리 + domain 매핑
          // JQ: 변환된 JSON에서 domain 필드를 추출하여 동적 파티셔닝에 사용
          ProcessingConfiguration: {
            Enabled: true,
            Processors: [
              // Lambda 변환 프로세서 (ARN이 있을 때만 추가)
              ...(lambdaArn
                ? [
                    {
                      Type: "Lambda" as const,
                      Parameters: [
                        {
                          ParameterName: "LambdaArn" as const,
                          ParameterValue: lambdaArn,
                        },
                        {
                          ParameterName: "RoleArn" as const,
                          ParameterValue: roleArn!,
                        },
                      ],
                    },
                  ]
                : []),
              {
                // JQ를 사용하여 JSON 레코드에서 domain 필드를 추출합니다.
                // 추출된 값은 동적 파티셔닝의 !{partitionKeyFromQuery:domain}에 매핑됩니다.
                Type: "MetadataExtraction",
                Parameters: [
                  {
                    ParameterName: "MetadataExtractionQuery",
                    ParameterValue: "{domain:.domain}",
                  },
                  {
                    ParameterName: "JsonParsingEngine",
                    ParameterValue: "JQ-1.6",
                  },
                ],
              },
              {
                // 각 레코드 끝에 줄바꿈(\n)을 추가합니다.
                // JSON Lines 포맷을 유지하기 위해 필요합니다.
                Type: "AppendDelimiterToRecord",
                Parameters: [
                  {
                    ParameterName: "Delimiter",
                    ParameterValue: "\\n",
                  },
                ],
              },
            ],
          },
        },
      })
    );

    const formatLabel = isParquet ? "Parquet" : "JSON";
    return {
      name: "Firehose Stream",
      status: "created",
      detail: `${streamName} (${formatLabel} 포맷 + 동적 파티셔닝 활성화)`,
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
// 결과 포매팅
// =============================================================

/**
 * 리소스 생성 결과를 MCP CallToolResult 형태로 포매팅합니다.
 *
 * 각 리소스별로 상태 아이콘을 붙여서 한눈에 파악할 수 있게 합니다:
 * - created -> 생성됨
 * - exists -> 이미 존재
 * - failed -> 실패
 */
function formatResults(results: ResourceResult[]) {
  const statusIcons: Record<ResourceStatus, string> = {
    created: "[created]",
    exists: "[exists]",
    failed: "[FAILED]",
  };

  const lines = results.map(
    (r) => `${statusIcons[r.status]} ${r.name}: ${r.detail}`
  );

  const createdCount = results.filter((r) => r.status === "created").length;
  const existsCount = results.filter((r) => r.status === "exists").length;
  const failedCount = results.filter((r) => r.status === "failed").length;

  const summary = `\n--- 요약 ---\n생성: ${createdCount}개 | 이미 존재: ${existsCount}개 | 실패: ${failedCount}개`;

  const hasFailure = failedCount > 0;

  return {
    content: [
      {
        type: "text" as const,
        text: `s3-logwatch 인프라 초기화 결과:\n\n${lines.join("\n")}${summary}`,
      },
    ],
    isError: hasFailure,
  };
}

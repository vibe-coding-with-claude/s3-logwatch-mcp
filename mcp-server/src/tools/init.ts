/**
 * init-infra MCP 도구
 *
 * 이 파일의 역할:
 * - "init-infra"라는 MCP 도구를 등록합니다.
 * - Claude Code가 "인프라 초기화해줘"라고 하면 이 도구가 호출됩니다.
 * - S3, Glue, IAM, Firehose, Athena 리소스를 한 번에 생성합니다.
 *
 * 멱등성(Idempotency):
 * - 이미 존재하는 리소스는 스킵합니다.
 * - 두 번 실행해도 에러 없이 동작합니다.
 * - 각 리소스마다 "이미 존재하는가?" 확인 -> 없으면 생성 패턴을 사용합니다.
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
  type CreateBucketCommandInput,
} from "@aws-sdk/client-s3";

import {
  GlueClient,
  CreateDatabaseCommand,
  GetDatabaseCommand,
  CreateTableCommand,
  GetTableCommand,
} from "@aws-sdk/client-glue";

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

import {
  AthenaClient,
  CreateWorkGroupCommand,
  GetWorkGroupCommand,
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

/** Glue 데이터베이스 이름. AWS Glue는 하이픈을 허용하지 않으므로 언더스코어를 사용합니다. */
const GLUE_DATABASE_NAME = "s3_logwatch";

/** Glue 테이블 이름 */
const GLUE_TABLE_NAME = "logs";

/** Firehose용 IAM 역할 이름 */
const FIREHOSE_ROLE_NAME = "s3-logwatch-firehose-role";

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
    "Initialize all AWS infrastructure for s3-logwatch. Creates S3 bucket, Glue database/table, IAM role, Kinesis Data Firehose delivery stream, and Athena workgroup. Safe to run multiple times (idempotent).",

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
// 메인 초기화 로직
// =============================================================

/**
 * 모든 AWS 리소스를 순서대로 생성합니다.
 *
 * 순서가 중요한 이유:
 * 1. S3 버킷: Firehose가 로그를 저장할 목적지
 * 2. Glue DB/테이블: Firehose가 Parquet 변환 시 스키마를 참조
 * 3. IAM 역할: Firehose가 S3에 쓰고 Glue를 읽을 권한
 * 4. Firehose: 위 3개가 다 준비된 후에야 생성 가능
 * 5. Athena 워크그룹: 독립적이지만 논리적으로 마지막
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
  const glue = new GlueClient({ region: resolvedRegion });
  const iam = new IAMClient({ region: resolvedRegion });
  const firehose = new FirehoseClient({ region: resolvedRegion });
  const athena = new AthenaClient({ region: resolvedRegion });

  // --- (a) S3 버킷 생성 ---
  results.push(await createS3Bucket(s3, config.s3.bucket, resolvedRegion));

  // --- (b) Glue 데이터베이스 생성 ---
  results.push(await createGlueDatabase(glue));

  // --- (c) Glue 테이블 생성 ---
  results.push(
    await createGlueTable(glue, config)
  );

  // --- (d) IAM 역할 생성 ---
  const accountId = await getAccountIdFromBucketArn(config.s3.bucket, resolvedRegion);
  results.push(
    await createFirehoseIamRole(iam, config.s3.bucket, resolvedRegion, accountId)
  );

  // --- (e) Firehose delivery stream 생성 ---
  // IAM 역할 생성 직후에는 AWS 내부 전파 지연이 있을 수 있습니다.
  // 실패하면 "잠시 후 다시 시도하세요" 안내를 포함합니다.
  results.push(
    await createFirehoseStream(firehose, config, resolvedRegion, accountId)
  );

  // --- (f) Athena 워크그룹 생성 ---
  results.push(
    await createAthenaWorkgroup(athena, config)
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
// (b) Glue 데이터베이스 생성
// =============================================================

/**
 * Glue 데이터베이스를 생성합니다.
 *
 * Glue Data Catalog란?
 * - AWS의 메타데이터 저장소입니다.
 * - Athena가 "어떤 테이블이 있고, 컬럼은 뭐고, 데이터는 어디에 있는지"를
 *   Glue Data Catalog에서 조회합니다.
 * - 데이터베이스 > 테이블 > 컬럼 계층 구조입니다.
 *
 * 왜 이름에 언더스코어를 사용하나?
 * - Glue 데이터베이스 이름에 하이픈(-)을 사용할 수 없습니다.
 * - "s3-logwatch" -> "s3_logwatch"로 변환합니다.
 */
async function createGlueDatabase(
  glue: GlueClient
): Promise<ResourceResult> {
  try {
    await glue.send(
      new GetDatabaseCommand({ Name: GLUE_DATABASE_NAME })
    );
    return {
      name: "Glue Database",
      status: "exists",
      detail: `${GLUE_DATABASE_NAME} (이미 존재)`,
    };
  } catch (error: unknown) {
    const errorName = (error as { name?: string })?.name ?? "";
    if (errorName !== "EntityNotFoundException") {
      const message = error instanceof Error ? error.message : String(error);
      return {
        name: "Glue Database",
        status: "failed",
        detail: `${GLUE_DATABASE_NAME} - ${message}`,
      };
    }
  }

  try {
    await glue.send(
      new CreateDatabaseCommand({
        DatabaseInput: {
          Name: GLUE_DATABASE_NAME,
          Description:
            "s3-logwatch: S3 로그 분석용 Glue 데이터베이스. Athena에서 이 DB의 테이블을 쿼리합니다.",
        },
      })
    );
    return {
      name: "Glue Database",
      status: "created",
      detail: GLUE_DATABASE_NAME,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "Glue Database",
      status: "failed",
      detail: `${GLUE_DATABASE_NAME} - ${message}`,
    };
  }
}

// =============================================================
// (c) Glue 테이블 생성
// =============================================================

/**
 * 스키마 컬럼의 타입을 Glue/Athena 호환 타입으로 매핑합니다.
 *
 * 왜 매핑이 필요한가?
 * - config.yaml에는 "timestamp", "string" 같은 간단한 타입명을 사용합니다.
 * - Glue는 Hive 타입 체계를 따르므로 변환이 필요합니다.
 * - 예: "timestamp" -> "timestamp" (동일), "string" -> "string" (동일)
 * - 향후 "int", "double" 등을 추가할 때 여기서 매핑합니다.
 */
function mapColumnType(configType: string): string {
  const typeMap: Record<string, string> = {
    string: "string",
    timestamp: "timestamp",
    int: "int",
    bigint: "bigint",
    double: "double",
    boolean: "boolean",
  };
  return typeMap[configType] ?? "string";
}

/**
 * Glue 테이블을 생성합니다.
 *
 * 이 테이블의 역할:
 * 1. Athena가 쿼리할 때 "이 테이블의 컬럼과 타입은 무엇인가?"를 여기서 조회합니다.
 * 2. Firehose가 Parquet 변환 시 "어떤 스키마로 변환할 것인가?"를 여기서 참조합니다.
 * 3. S3 데이터의 위치(Location)를 지정합니다.
 *
 * InputFormat/OutputFormat/SerDe 설명:
 * - SerDe(Serializer/Deserializer): 데이터를 읽고 쓰는 방법을 정의합니다.
 * - JSON SerDe: org.openx.data.jsonserde.JsonSerDe
 * - JSON을 사용하는 이유: mock 데이터와 CloudWatch Logs 원본 모두 JSON 포맷.
 *   Firehose Parquet 변환은 별도 경로에서 처리하고,
 *   이 테이블은 JSON Lines 파일을 직접 읽습니다.
 */
async function createGlueTable(
  glue: GlueClient,
  config: ReturnType<typeof loadConfig>
): Promise<ResourceResult> {
  try {
    await glue.send(
      new GetTableCommand({
        DatabaseName: GLUE_DATABASE_NAME,
        Name: GLUE_TABLE_NAME,
      })
    );
    return {
      name: "Glue Table",
      status: "exists",
      detail: `${GLUE_DATABASE_NAME}.${GLUE_TABLE_NAME} (이미 존재)`,
    };
  } catch (error: unknown) {
    const errorName = (error as { name?: string })?.name ?? "";
    if (errorName !== "EntityNotFoundException") {
      const message = error instanceof Error ? error.message : String(error);
      return {
        name: "Glue Table",
        status: "failed",
        detail: `${GLUE_DATABASE_NAME}.${GLUE_TABLE_NAME} - ${message}`,
      };
    }
  }

  try {
    // config.yaml의 schema.columns를 Glue 컬럼 형식으로 변환
    let columns = config.schema.columns.map((col) => ({
      Name: col.name,
      Type: mapColumnType(col.type),
    }));

    // 파티션 키와 겹치는 컬럼을 제거합니다
    // Glue에서 파티션 키와 일반 컬럼에 같은 이름이 있으면 "duplicate columns" 에러가 발생합니다
    const partitionKeyNames = new Set(config.partitioning.keys);
    columns = columns.filter((c) => !partitionKeyNames.has(c.Name));

    // 파티션 키를 Glue 컬럼 형식으로 변환
    // 파티션 키는 모두 string 타입입니다 (Hive 파티셔닝 디렉토리 이름이므로)
    const partitionKeys = config.partitioning.keys.map((key) => ({
      Name: key,
      Type: "string",
    }));

    // S3 데이터 위치: s3://버킷/prefix
    const location = `s3://${config.s3.bucket}/${config.s3.prefix}`;

    await glue.send(
      new CreateTableCommand({
        DatabaseName: GLUE_DATABASE_NAME,
        TableInput: {
          Name: GLUE_TABLE_NAME,
          Description:
            "s3-logwatch 로그 테이블. Firehose가 Parquet로 변환하여 S3에 저장한 로그를 Athena로 쿼리합니다.",
          // 일반 컬럼 (파티션 키 제외)
          StorageDescriptor: {
            Columns: columns,
            Location: location,
            // JSON 입력 포맷: S3의 JSON Lines 파일을 읽습니다
            InputFormat: "org.apache.hadoop.mapred.TextInputFormat",
            // 텍스트 출력 포맷
            OutputFormat:
              "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
            // SerDe: JSON 데이터를 읽고 쓰는 방법을 정의
            // OpenX JSON SerDe는 Athena가 공식 지원하는 JSON 파서입니다
            SerdeInfo: {
              SerializationLibrary: "org.openx.data.jsonserde.JsonSerDe",
              Parameters: {
                // case.insensitive: JSON 키의 대소문자를 구분하지 않음
                "case.insensitive": "true",
              },
            },
            Compressed: false,
            StoredAsSubDirectories: false,
          },
          // 파티션 키: Hive 스타일 파티셔닝에 사용됩니다
          // 이 키들이 S3 경로의 디렉토리 구조가 됩니다
          // 예: level=ERROR/domain=payment/year=2026/month=03/day=28/
          PartitionKeys: partitionKeys,
          // 테이블 타입: 외부 테이블 (S3의 데이터를 직접 참조)
          TableType: "EXTERNAL_TABLE",
          Parameters: {
            // JSON 분류
            classification: "json",
            // 파티션 프로젝션: Athena가 파티션을 자동 인식하도록 설정
            // MSCK REPAIR TABLE을 실행하지 않아도 새 파티션을 인식합니다
            "projection.enabled": "true",
            "projection.level.type": "enum",
            "projection.level.values": "TRACE,DEBUG,INFO,WARN,ERROR,FATAL",
            "projection.domain.type": "enum",
            "projection.domain.values": "payment,auth,order,user,notification",
            "projection.year.type": "integer",
            "projection.year.range": "2024,2030",
            "projection.month.type": "integer",
            "projection.month.range": "1,12",
            "projection.month.digits": "2",
            "projection.day.type": "integer",
            "projection.day.range": "1,31",
            "projection.day.digits": "2",
            // 파티션 프로젝션의 저장 위치 템플릿
            "storage.location.template": `s3://${config.s3.bucket}/${config.s3.prefix}level=\${level}/domain=\${domain}/year=\${year}/month=\${month}/day=\${day}/`,
          },
        },
      })
    );

    return {
      name: "Glue Table",
      status: "created",
      detail: `${GLUE_DATABASE_NAME}.${GLUE_TABLE_NAME}`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "Glue Table",
      status: "failed",
      detail: `${GLUE_DATABASE_NAME}.${GLUE_TABLE_NAME} - ${message}`,
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
 * - Glue: GetTable, GetDatabase (Parquet 변환 시 스키마 조회)
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
          // Glue 테이블 스키마를 조회하는 권한 (Parquet 변환에 필요)
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
            `arn:aws:glue:${region}:*:database/${GLUE_DATABASE_NAME}`,
            `arn:aws:glue:${region}:*:table/${GLUE_DATABASE_NAME}/${GLUE_TABLE_NAME}`,
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
// (e) Firehose Delivery Stream 생성
// =============================================================

/**
 * Kinesis Data Firehose delivery stream을 생성합니다.
 *
 * Firehose란?
 * - AWS의 스트리밍 데이터 전송 서비스입니다.
 * - CloudWatch Logs에서 받은 JSON 로그를 Parquet으로 변환하여 S3에 저장합니다.
 * - 버퍼링: 일정 시간(buffer_interval) 또는 크기(buffer_size)가 차면 S3에 씁니다.
 *
 * ExtendedS3DestinationConfiguration:
 * - Firehose의 S3 출력 설정입니다.
 * - Prefix: Hive 파티셔닝 경로 (level=ERROR/domain=payment/...)
 * - DataFormatConversionConfiguration: JSON -> Parquet 변환 설정
 *
 * Hive 파티셔닝 Prefix 문법:
 * - !{partitionKeyFromQuery:level}: 로그의 level 필드 값을 파티션 경로에 사용
 * - !{timestamp:yyyy}: 타임스탬프에서 연도를 추출하여 경로에 사용
 */
async function createFirehoseStream(
  firehose: FirehoseClient,
  config: ReturnType<typeof loadConfig>,
  region: string,
  _accountId: string
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

    // Hive 파티셔닝 Prefix 설명:
    // level=!{partitionKeyFromQuery:level}: 로그 JSON의 level 필드값
    // domain=!{partitionKeyFromQuery:domain}: 로그 JSON의 domain 필드값
    // year=!{timestamp:yyyy}: 전송 시간의 연도
    // month=!{timestamp:MM}: 전송 시간의 월
    // day=!{timestamp:dd}: 전송 시간의 일
    const prefix =
      `${config.s3.prefix}level=!{partitionKeyFromQuery:level}/` +
      `domain=!{partitionKeyFromQuery:domain}/` +
      `year=!{timestamp:yyyy}/` +
      `month=!{timestamp:MM}/` +
      `day=!{timestamp:dd}/`;

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
          ErrorOutputPrefix: `${config.s3.prefix}errors/`,
          // 버퍼링 설정: 이 조건 중 하나라도 충족되면 S3에 파일을 씁니다
          BufferingHints: {
            IntervalInSeconds: config.firehose.buffer_interval,
            SizeInMBs: config.firehose.buffer_size,
          },
          // 압축: Parquet 자체에 압축이 포함되므로 UNCOMPRESSED
          CompressionFormat: "UNCOMPRESSED",
          // JSON -> Parquet 변환 설정
          DataFormatConversionConfiguration: {
            Enabled: true,
            // 입력 포맷: JSON (CloudWatch Logs에서 오는 데이터)
            InputFormatConfiguration: {
              Deserializer: {
                OpenXJsonSerDe: {},
              },
            },
            // 출력 포맷: Parquet (S3에 저장되는 데이터)
            OutputFormatConfiguration: {
              Serializer: {
                ParquetSerDe: {},
              },
            },
            // 스키마 소스: Glue 테이블 (컬럼 이름과 타입을 여기서 참조)
            SchemaConfiguration: {
              RoleARN: roleArn,
              DatabaseName: GLUE_DATABASE_NAME,
              TableName: GLUE_TABLE_NAME,
              Region: region,
              VersionId: "LATEST",
            },
          },
          // 동적 파티셔닝: 로그 필드값을 기반으로 S3 경로를 결정합니다
          DynamicPartitioningConfiguration: {
            Enabled: true,
          },
          // 파티션 키 추출을 위한 JQ 프로세서
          // CloudWatch에서 온 JSON 로그에서 level, domain 필드를 추출합니다
          ProcessingConfiguration: {
            Enabled: true,
            Processors: [
              {
                Type: "MetadataExtraction",
                Parameters: [
                  {
                    ParameterName: "MetadataExtractionQuery",
                    ParameterValue: '{level:.level, domain:.domain}',
                  },
                  {
                    ParameterName: "JsonParsingEngine",
                    ParameterValue: "JQ-1.6",
                  },
                ],
              },
            ],
          },
        },
      })
    );

    return {
      name: "Firehose Stream",
      status: "created",
      detail: `${streamName} (Parquet 변환 + Hive 파티셔닝 활성화)`,
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
// (f) Athena 워크그룹 생성
// =============================================================

/**
 * Athena 워크그룹을 생성합니다.
 *
 * 워크그룹이란?
 * - Athena 쿼리 실행 환경을 격리하는 단위입니다.
 * - 쿼리 결과 저장 위치, 스캔량 제한 등을 워크그룹 단위로 설정합니다.
 * - s3-logwatch 전용 워크그룹을 만들어 다른 Athena 사용과 분리합니다.
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

/**
 * init-infra 도구 로직을 직접 실행하는 스크립트
 * MCP 프로토콜 없이 AWS 리소스를 생성합니다.
 *
 * 생성 순서 (의존성 순서):
 * 1. S3 버킷 -- Firehose 목적지
 * 2. Athena 워크그룹 -- DDL 실행에 필요
 * 3. Athena DDL로 데이터베이스 + 테이블 생성 -- Glue Data Catalog에 자동 등록
 * 4. IAM 역할 -- Firehose가 S3/Glue에 접근하기 위한 권한
 * 5. Firehose delivery stream -- 로그 수집 파이프라인 핵심
 *
 * Glue SDK 제거:
 * - 이전에는 Glue SDK로 테이블을 생성했지만, Athena DDL로 대체했습니다.
 * - Athena에서 CREATE TABLE하면 내부적으로 Glue Data Catalog에 등록됩니다.
 */

import { S3Client, CreateBucketCommand, HeadBucketCommand, type CreateBucketCommandInput } from "@aws-sdk/client-s3";
import {
  AthenaClient,
  CreateWorkGroupCommand,
  GetWorkGroupCommand,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
} from "@aws-sdk/client-athena";
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
  LambdaClient,
  CreateFunctionCommand,
  GetFunctionCommand,
} from "@aws-sdk/client-lambda";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { loadConfig } from "../src/config.js";

const REGION = process.env.E2E_REGION ?? loadConfig().region;
const config = loadConfig();

const DATABASE_NAME = config.resource_names.database;
const TABLE_NAME = config.resource_names.table;
const FIREHOSE_ROLE_NAME = config.resource_names.firehose_role;
const LAMBDA_ROLE_NAME = config.resource_names.lambda_role;
const LAMBDA_FUNCTION_NAME = config.resource_names.lambda_function;

/**
 * 지정된 밀리초만큼 대기합니다.
 * Firehose가 ACTIVE 상태가 될 때까지 폴링할 때 사용합니다.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Athena DDL을 실행하고 완료까지 폴링합니다.
 * @param athena - AthenaClient 인스턴스
 * @param sql - 실행할 DDL SQL
 */
async function executeAthenaDDL(athena: AthenaClient, sql: string): Promise<void> {
  const start = await athena.send(new StartQueryExecutionCommand({
    QueryString: sql,
    WorkGroup: config.athena.workgroup,
    ResultConfiguration: { OutputLocation: config.athena.output_location },
  }));

  const queryId = start.QueryExecutionId!;

  // 완료까지 1초 간격으로 폴링
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

async function main() {
  console.log("\n=== init-infra 실행 ===\n");
  console.log(`리전: ${REGION}`);
  console.log(`S3 버킷: ${config.s3.bucket}`);
  console.log(`Firehose 스트림: ${config.firehose.delivery_stream}`);
  console.log(`Athena 워크그룹: ${config.athena.workgroup}\n`);

  const s3 = new S3Client({ region: REGION });
  const athena = new AthenaClient({ region: REGION });
  const iam = new IAMClient({ region: REGION });
  const firehose = new FirehoseClient({ region: REGION });

  // -------------------------------------------------------
  // 1. S3 버킷
  // -------------------------------------------------------
  try {
    await s3.send(new HeadBucketCommand({ Bucket: config.s3.bucket }));
    console.log(`[exists] S3 버킷 이미 존재: ${config.s3.bucket}`);
  } catch {
    const input: CreateBucketCommandInput = { Bucket: config.s3.bucket };
    if (REGION !== "us-east-1") {
      input.CreateBucketConfiguration = {
        LocationConstraint: REGION as CreateBucketCommandInput["CreateBucketConfiguration"] extends
          | { LocationConstraint?: infer L }
          | undefined
          ? L
          : never,
      };
    }
    await s3.send(new CreateBucketCommand(input));
    console.log(`[created] S3 버킷 생성: ${config.s3.bucket}`);
  }

  // -------------------------------------------------------
  // 2. Athena 워크그룹 (DDL 실행 전에 워크그룹이 필요)
  // -------------------------------------------------------
  try {
    await athena.send(new GetWorkGroupCommand({ WorkGroup: config.athena.workgroup }));
    console.log(`[exists] Athena 워크그룹 이미 존재: ${config.athena.workgroup}`);
  } catch {
    await athena.send(new CreateWorkGroupCommand({
      Name: config.athena.workgroup,
      Description: "s3-logwatch Athena workgroup",
      Configuration: {
        ResultConfiguration: { OutputLocation: config.athena.output_location },
        EnforceWorkGroupConfiguration: true,
        PublishCloudWatchMetricsEnabled: true,
      },
    }));
    console.log(`[created] Athena 워크그룹 생성: ${config.athena.workgroup}`);
  }

  // -------------------------------------------------------
  // 3. Athena DDL로 데이터베이스 + 테이블 생성
  // Glue SDK 대신 Athena DDL을 사용합니다.
  // CREATE DATABASE/TABLE IF NOT EXISTS로 멱등성을 보장합니다.
  // -------------------------------------------------------
  console.log("Athena DDL로 데이터베이스 생성 중...");
  await executeAthenaDDL(athena, `CREATE DATABASE IF NOT EXISTS ${DATABASE_NAME}`);
  console.log(`[created/exists] 데이터베이스: ${DATABASE_NAME}`);

  // config.domains에서 도메인 이름 목록을 동적으로 추출
  const domainValues = config.domains.map(d => d.name).join(",");

  const createTableDDL = `
    CREATE EXTERNAL TABLE IF NOT EXISTS ${DATABASE_NAME}.${TABLE_NAME} (
      timestamp string,
      level string,
      service string,
      message string,
      trace_id string
    )
    PARTITIONED BY (domain string, year string, month string, day string)
    ROW FORMAT SERDE 'org.openx.data.jsonserde.JsonSerDe'
    WITH SERDEPROPERTIES ('case.insensitive' = 'true')
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

  console.log("Athena DDL로 테이블 생성 중...");
  await executeAthenaDDL(athena, createTableDDL);
  console.log(`[created/exists] 테이블: ${DATABASE_NAME}.${TABLE_NAME} (Athena DDL, Partition Projection)`);

  // -------------------------------------------------------
  // 4. IAM 역할 (Firehose -> S3/Glue 접근용)
  // -------------------------------------------------------
  let roleArn: string | undefined;

  try {
    const resp = await iam.send(new GetRoleCommand({ RoleName: FIREHOSE_ROLE_NAME }));
    roleArn = resp.Role?.Arn;
    console.log(`[exists] IAM 역할 이미 존재: ${FIREHOSE_ROLE_NAME}`);
  } catch (error: unknown) {
    const errorName = (error as { name?: string })?.name ?? "";
    if (errorName !== "NoSuchEntityException") {
      throw error;
    }

    // Trust Policy: Firehose 서비스만 이 역할을 assume할 수 있습니다
    const trustPolicy = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "firehose.amazonaws.com" },
          Action: "sts:AssumeRole",
        },
      ],
    };

    const createResp = await iam.send(new CreateRoleCommand({
      RoleName: FIREHOSE_ROLE_NAME,
      AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
      Description: "s3-logwatch: Firehose role for S3 write and Glue read access",
    }));
    roleArn = createResp.Role?.Arn;

    // Inline Policy: S3 PutObject + Glue GetTable
    // Glue 권한은 여전히 필요 (Athena DDL로 생성해도 Glue Data Catalog를 참조하므로)
    const inlinePolicy = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "S3Access",
          Effect: "Allow",
          Action: [
            "s3:PutObject",
            "s3:GetObject",
            "s3:ListBucket",
            "s3:GetBucketLocation",
          ],
          Resource: [
            `arn:aws:s3:::${config.s3.bucket}`,
            `arn:aws:s3:::${config.s3.bucket}/*`,
          ],
        },
        {
          Sid: "GlueAccess",
          Effect: "Allow",
          Action: [
            "glue:GetTable",
            "glue:GetTableVersion",
            "glue:GetTableVersions",
            "glue:GetDatabase",
          ],
          Resource: [
            `arn:aws:glue:${REGION}:*:catalog`,
            `arn:aws:glue:${REGION}:*:database/${DATABASE_NAME}`,
            `arn:aws:glue:${REGION}:*:table/${DATABASE_NAME}/${TABLE_NAME}`,
          ],
        },
      ],
    };

    await iam.send(new PutRolePolicyCommand({
      RoleName: FIREHOSE_ROLE_NAME,
      PolicyName: "s3-logwatch-firehose-policy",
      PolicyDocument: JSON.stringify(inlinePolicy),
    }));

    console.log(`[created] IAM 역할 생성: ${FIREHOSE_ROLE_NAME} (S3 PutObject + Glue GetTable)`);
  }

  if (!roleArn) {
    throw new Error("IAM 역할 ARN을 가져올 수 없습니다. IAM 역할 생성을 확인하세요.");
  }

  // -------------------------------------------------------
  // 5. Firehose Delivery Stream (동적 파티셔닝 + JSON 유지)
  // -------------------------------------------------------
  try {
    await firehose.send(new DescribeDeliveryStreamCommand({
      DeliveryStreamName: config.firehose.delivery_stream,
    }));
    console.log(`[exists] Firehose 스트림 이미 존재: ${config.firehose.delivery_stream}`);
  } catch (error: unknown) {
    const errorName = (error as { name?: string })?.name ?? "";
    if (errorName !== "ResourceNotFoundException") {
      throw error;
    }

    const bucketArn = `arn:aws:s3:::${config.s3.bucket}`;

    // 동적 파티셔닝 Prefix: domain 폴더 + 시간 파티션
    const prefix =
      `${config.s3.base_prefix}` +
      `!{partitionKeyFromQuery:domain}/` +
      `!{timestamp:yyyy}/` +
      `!{timestamp:MM}/` +
      `!{timestamp:dd}/`;

    await firehose.send(new CreateDeliveryStreamCommand({
      DeliveryStreamName: config.firehose.delivery_stream,
      DeliveryStreamType: "DirectPut",
      ExtendedS3DestinationConfiguration: {
        RoleARN: roleArn,
        BucketARN: bucketArn,
        Prefix: prefix,
        ErrorOutputPrefix: `${config.s3.base_prefix}errors/`,
        BufferingHints: {
          IntervalInSeconds: config.firehose.buffer_interval,
          // Dynamic Partitioning 사용 시 최소 64MB 필요
          SizeInMBs: Math.max(config.firehose.buffer_size, 64),
        },
        // JSON 원본을 그대로 저장 (Parquet 변환 비활성화)
        CompressionFormat: "UNCOMPRESSED",
        // 동적 파티셔닝: domain 필드 기반으로 S3 경로를 분기
        DynamicPartitioningConfiguration: {
          Enabled: true,
        },
        // JQ로 domain 필드 추출 + 줄바꿈 구분자 추가
        ProcessingConfiguration: {
          Enabled: true,
          Processors: [
            {
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
              // 각 레코드 끝에 줄바꿈 추가 (JSON Lines 포맷 유지)
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
    }));

    console.log(`[created] Firehose 스트림 생성 요청: ${config.firehose.delivery_stream}`);

    // Firehose가 ACTIVE 상태가 될 때까지 폴링 (최대 60초)
    const maxWaitMs = 60_000;
    const pollIntervalMs = 5_000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const desc = await firehose.send(new DescribeDeliveryStreamCommand({
        DeliveryStreamName: config.firehose.delivery_stream,
      }));
      const status = desc.DeliveryStreamDescription?.DeliveryStreamStatus;
      console.log(`  Firehose 상태: ${status}`);

      if (status === "ACTIVE") {
        console.log(`[active] Firehose 스트림 활성화 완료: ${config.firehose.delivery_stream}`);
        break;
      }

      if (status !== "CREATING") {
        throw new Error(`Firehose 스트림이 예상치 못한 상태입니다: ${status}`);
      }

      await sleep(pollIntervalMs);
    }

    // 타임아웃 체크
    const finalDesc = await firehose.send(new DescribeDeliveryStreamCommand({
      DeliveryStreamName: config.firehose.delivery_stream,
    }));
    if (finalDesc.DeliveryStreamDescription?.DeliveryStreamStatus !== "ACTIVE") {
      console.warn(`[warn] Firehose 스트림이 60초 내에 ACTIVE가 되지 않았습니다. 수동 확인이 필요합니다.`);
    }
  }

  // -------------------------------------------------------
  // 6. Lambda IAM 역할
  // -------------------------------------------------------
  let lambdaRoleArn: string | undefined;

  try {
    const resp = await iam.send(new GetRoleCommand({ RoleName: LAMBDA_ROLE_NAME }));
    lambdaRoleArn = resp.Role?.Arn;
    console.log(`[exists] Lambda IAM 역할 이미 존재: ${LAMBDA_ROLE_NAME}`);
  } catch (error: unknown) {
    const errorName = (error as { name?: string })?.name ?? "";
    if (errorName !== "NoSuchEntityException") throw error;

    const trustPolicy = {
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: { Service: "lambda.amazonaws.com" },
        Action: "sts:AssumeRole",
      }],
    };

    const createResp = await iam.send(new CreateRoleCommand({
      RoleName: LAMBDA_ROLE_NAME,
      AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
      Description: "s3-logwatch: Lambda role for CloudWatch Logs write",
    }));
    lambdaRoleArn = createResp.Role?.Arn;

    await iam.send(new PutRolePolicyCommand({
      RoleName: LAMBDA_ROLE_NAME,
      PolicyName: "s3-logwatch-lambda-policy",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
          Resource: `arn:aws:logs:${REGION}:*:*`,
        }],
      }),
    }));

    console.log(`[created] Lambda IAM 역할 생성: ${LAMBDA_ROLE_NAME}`);
    // IAM 전파 대기
    await sleep(10000);
  }

  // -------------------------------------------------------
  // 7. Lambda 함수 (Python 3.12)
  // -------------------------------------------------------
  const lambdaClient = new LambdaClient({ region: REGION });
  let lambdaArn: string | undefined;

  try {
    const resp = await lambdaClient.send(new GetFunctionCommand({ FunctionName: LAMBDA_FUNCTION_NAME }));
    lambdaArn = resp.Configuration?.FunctionArn;
    console.log(`[exists] Lambda 함수 이미 존재: ${LAMBDA_FUNCTION_NAME}`);
  } catch (error: unknown) {
    const errorName = (error as { name?: string })?.name ?? "";
    if (errorName !== "ResourceNotFoundException") throw error;

    // Python 코드를 zip으로 패키징
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const lambdaSourcePath = join(currentDir, "..", "src", "lambda", "transformer.py");
    const pythonCode = readFileSync(lambdaSourcePath, "utf-8");

    const tmpDir = join(currentDir, "..", ".lambda-build");
    execSync(`mkdir -p ${tmpDir}`);
    writeFileSync(join(tmpDir, "lambda_function.py"), pythonCode, "utf-8");
    execSync(`cd ${tmpDir} && rm -f lambda.zip && zip lambda.zip lambda_function.py`);
    const zipBuffer = readFileSync(join(tmpDir, "lambda.zip"));
    execSync(`rm -rf ${tmpDir}`);

    // domain 매핑: config.connections에서 생성
    const domainMapping: Record<string, string> = {};
    for (const conn of config.connections) {
      domainMapping[conn.log_group] = conn.domain;
    }

    const createResp = await lambdaClient.send(new CreateFunctionCommand({
      FunctionName: LAMBDA_FUNCTION_NAME,
      Runtime: "python3.12",
      Role: lambdaRoleArn,
      Handler: "lambda_function.handler",
      Code: { ZipFile: zipBuffer },
      Description: "s3-logwatch: CloudWatch Logs gzip decode + domain mapping",
      Timeout: 60,
      MemorySize: 128,
      Environment: {
        Variables: {
          DOMAIN_MAPPING: JSON.stringify(domainMapping),
        },
      },
    }));
    lambdaArn = createResp.FunctionArn;

    console.log(`[created] Lambda 함수 생성: ${LAMBDA_FUNCTION_NAME} (Python 3.12)`);
  }

  console.log("\n=== init-infra 완료 ===\n");
}

main().catch((err) => {
  console.error("init-infra 실패:", err);
  process.exit(1);
});

/**
 * Mock 로그 데이터 생성 스크립트
 *
 * S3에 Hive Partitioning 구조로 mock 로그를 직접 업로드합니다.
 * Firehose를 거치지 않고 직접 S3에 JSON 파일로 넣되,
 * Athena가 읽을 수 있도록 Glue 테이블의 SerDe에 맞는 포맷으로 저장합니다.
 *
 * 로그 종류 5가지 x 100개 = 500개 (총 합 500개 이하)
 *   - ERROR: payment, auth 도메인
 *   - WARN: order, auth 도메인
 *   - INFO: payment, order, user 도메인
 *   - DEBUG: user, notification 도메인
 *   - TRACE: notification 도메인
 *
 * 실행: npx tsx scripts/seed-mock-logs.ts
 */

import {
  S3Client,
  PutObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { loadConfig } from "../src/config.js";

// =============================================================
// 설정
// =============================================================
const REGION = process.env.E2E_REGION ?? "us-east-1";
const config = loadConfig();
const s3 = new S3Client({ region: REGION });

// =============================================================
// Mock 데이터 정의
// =============================================================

/** 로그 레벨별 도메인과 메시지 템플릿 */
const LOG_TEMPLATES: Record<
  string,
  { domains: string[]; messages: string[] }
> = {
  ERROR: {
    domains: ["payment", "auth"],
    messages: [
      "NullPointerException in processPayment",
      "Connection timeout to payment gateway",
      "Invalid card number format",
      "Authentication token expired",
      "Database connection pool exhausted",
      "SSL handshake failed",
      "Rate limit exceeded for API key",
      "Insufficient funds for transaction",
      "Invalid OAuth2 redirect URI",
      "Session validation failed",
    ],
  },
  WARN: {
    domains: ["order", "auth"],
    messages: [
      "Slow query detected: 2.3s for order lookup",
      "Retry attempt 2/3 for order creation",
      "Deprecated API version used by client",
      "Cache miss rate above threshold: 45%",
      "Memory usage above 80%",
      "Auth token near expiration: 5m remaining",
      "Fallback to secondary database",
      "Request payload size exceeds recommendation",
      "Concurrent session limit approaching",
      "Certificate renewal due in 7 days",
    ],
  },
  INFO: {
    domains: ["payment", "order", "user"],
    messages: [
      "Payment processed successfully",
      "Order created: ORD-2026-",
      "User registered: USR-",
      "Webhook delivered to merchant",
      "Daily report generated",
      "Cache refreshed for product catalog",
      "Health check passed",
      "Batch job completed: 1,234 records",
      "API response time p99: 145ms",
      "Deployment v2.3.1 completed",
    ],
  },
  DEBUG: {
    domains: ["user", "notification"],
    messages: [
      "Parsing user preferences JSON",
      "Email template compiled: welcome_v2",
      "Push notification queued for delivery",
      "User session extended by 30m",
      "Notification batch size: 50",
      "SMS gateway response: 200 OK",
      "Profile image resized to 256x256",
      "Preference sync completed",
      "FCM token refreshed for device",
      "WebSocket connection established",
    ],
  },
  TRACE: {
    domains: ["notification"],
    messages: [
      "Entering sendNotification()",
      "Loading template from cache",
      "Resolving recipient list",
      "Formatting message body",
      "Connecting to SMTP server",
      "SMTP handshake completed",
      "Message queued in outbox",
      "Delivery confirmation received",
      "Updating delivery status in DB",
      "Exiting sendNotification()",
    ],
  },
};

/** 서비스 이름 매핑 */
const DOMAIN_SERVICES: Record<string, string[]> = {
  payment: ["payment-api", "payment-worker"],
  auth: ["auth-service", "auth-gateway"],
  order: ["order-api", "order-processor"],
  user: ["user-api", "user-profile"],
  notification: ["notification-service", "email-worker"],
};

// =============================================================
// 로그 생성 함수
// =============================================================

interface LogEntry {
  timestamp: string;
  level: string;
  domain: string;
  service: string;
  message: string;
  trace_id: string;
}

function generateTraceId(): string {
  const hex = () =>
    Math.floor(Math.random() * 0xffff)
      .toString(16)
      .padStart(4, "0");
  return `${hex()}${hex()}-${hex()}-${hex()}-${hex()}-${hex()}${hex()}${hex()}`;
}

function generateTimestamp(daysAgo: number): string {
  const now = new Date();
  const date = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  // 시간을 랜덤하게 분산
  date.setHours(Math.floor(Math.random() * 24));
  date.setMinutes(Math.floor(Math.random() * 60));
  date.setSeconds(Math.floor(Math.random() * 60));
  return date.toISOString();
}

function generateLogs(
  level: string,
  count: number
): LogEntry[] {
  const template = LOG_TEMPLATES[level];
  const logs: LogEntry[] = [];

  for (let i = 0; i < count; i++) {
    const domain =
      template.domains[Math.floor(Math.random() * template.domains.length)];
    const services = DOMAIN_SERVICES[domain];
    const service = services[Math.floor(Math.random() * services.length)];
    const message =
      template.messages[Math.floor(Math.random() * template.messages.length)];
    // 최근 3일 이내의 로그
    const daysAgo = Math.floor(Math.random() * 3);

    logs.push({
      timestamp: generateTimestamp(daysAgo),
      level,
      domain,
      service,
      message: `${message}${i}`,
      trace_id: generateTraceId(),
    });
  }

  return logs;
}

// =============================================================
// S3 업로드 (Hive Partitioning)
// =============================================================

/**
 * 로그를 Hive Partitioning 구조로 S3에 업로드합니다.
 *
 * 경로 형식:
 *   s3://bucket/logs/level=ERROR/domain=payment/year=2026/month=03/day=28/batch-001.json
 *
 * 왜 JSON Lines 포맷인가?
 * - Athena가 JSON SerDe (org.openx.data.jsonserde.JsonSerDe)로 읽을 수 있습니다.
 * - 한 줄에 하나의 JSON 객체 = 한 로그 레코드
 * - Glue 테이블의 InputFormat을 JSON으로 맞춰야 합니다.
 *
 * 참고: 실제 운영에서는 Firehose가 Parquet으로 변환하여 저장하지만,
 * mock 데이터는 빠른 테스트를 위해 JSON으로 직접 넣습니다.
 */
async function uploadLogsToS3(logs: LogEntry[]): Promise<number> {
  // 로그를 파티션별로 그룹핑
  const partitions = new Map<string, LogEntry[]>();

  for (const log of logs) {
    const date = new Date(log.timestamp);
    const year = date.getFullYear().toString();
    const month = (date.getMonth() + 1).toString().padStart(2, "0");
    const day = date.getDate().toString().padStart(2, "0");

    const key = `level=${log.level}/domain=${log.domain}/year=${year}/month=${month}/day=${day}`;
    if (!partitions.has(key)) {
      partitions.set(key, []);
    }
    partitions.get(key)!.push(log);
  }

  let uploadedFiles = 0;

  for (const [partitionKey, partitionLogs] of partitions) {
    // JSON Lines 포맷: 한 줄에 하나의 JSON 객체
    // 파티션 키 필드(level, domain, year, month, day)는 경로에서 추론되므로
    // 데이터에는 나머지 필드만 포함해도 되지만, 편의상 전체를 넣습니다.
    const jsonLines = partitionLogs
      .map((log) => JSON.stringify(log))
      .join("\n");

    const s3Key = `${config.s3.prefix}${partitionKey}/mock-batch-${Date.now()}.json`;

    await s3.send(
      new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: s3Key,
        Body: jsonLines,
        ContentType: "application/json",
      })
    );

    uploadedFiles++;
    console.log(`  ✅ ${s3Key} (${partitionLogs.length}건)`);
  }

  return uploadedFiles;
}

// =============================================================
// 메인 실행
// =============================================================

async function main(): Promise<void> {
  console.log("\n=== s3-logwatch Mock 로그 생성기 ===\n");
  console.log(`S3 버킷: ${config.s3.bucket}`);
  console.log(`리전: ${REGION}\n`);

  // S3 버킷 존재 확인
  try {
    await s3.send(new HeadBucketCommand({ Bucket: config.s3.bucket }));
    console.log(`✅ S3 버킷 확인됨: ${config.s3.bucket}\n`);
  } catch {
    console.error(
      `❌ S3 버킷이 존재하지 않습니다: ${config.s3.bucket}\n` +
        `먼저 init-infra를 실행하세요.`
    );
    process.exit(1);
  }

  // 로그 생성 (5종류 x 100개 = 500개)
  const logCounts: Record<string, number> = {
    ERROR: 100,
    WARN: 100,
    INFO: 100,
    DEBUG: 100,
    TRACE: 100,
  };

  let totalLogs = 0;
  const allLogs: LogEntry[] = [];

  for (const [level, count] of Object.entries(logCounts)) {
    const logs = generateLogs(level, count);
    allLogs.push(...logs);
    totalLogs += logs.length;
    console.log(`📝 ${level}: ${count}개 생성`);
  }

  console.log(`\n총 ${totalLogs}개 로그 생성 완료\n`);

  // S3 업로드
  console.log("S3 업로드 시작...\n");
  const uploadedFiles = await uploadLogsToS3(allLogs);

  console.log(`\n=== 완료 ===`);
  console.log(`총 로그: ${totalLogs}개`);
  console.log(`S3 파일: ${uploadedFiles}개 (파티션별 그룹핑)`);
  console.log(`\n다음 단계:`);
  console.log(`  1. Athena에서 쿼리 테스트:`);
  console.log(
    `     SELECT level, domain, count(*) as cnt FROM s3_logwatch.logs GROUP BY level, domain ORDER BY cnt DESC`
  );
  console.log(
    `  2. 파티션 필터 테스트:`
  );
  console.log(
    `     SELECT * FROM s3_logwatch.logs WHERE level='ERROR' AND domain='payment' LIMIT 10`
  );
}

main().catch((error: unknown) => {
  console.error("Mock 로그 생성 실패:", error);
  process.exit(1);
});

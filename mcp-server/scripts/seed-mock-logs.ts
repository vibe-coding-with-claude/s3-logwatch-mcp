/**
 * Mock 로그 데이터 생성 스크립트
 *
 * S3에 도메인별 경로 구조로 mock 로그를 직접 업로드합니다.
 * Firehose를 거치지 않고 직접 S3에 JSON 파일로 넣되,
 * Athena가 읽을 수 있도록 Glue 테이블의 SerDe에 맞는 포맷으로 저장합니다.
 *
 * 경로 구조: seungjae/{domain}/{year}/{month}/{day}/
 * 도메인 5개 x 100건 = 500건:
 *   - user(100건), order(100건), payment(100건), auth(100건), notification(100건)
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
const REGION = process.env.E2E_REGION ?? loadConfig().region;
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

/**
 * 도메인별로 로그를 생성합니다.
 * 각 도메인에서 다양한 레벨의 로그가 나옵니다.
 */
function generateLogsForDomain(
  domain: string,
  count: number
): LogEntry[] {
  const levels = Object.keys(LOG_TEMPLATES);
  const services = DOMAIN_SERVICES[domain];
  const logs: LogEntry[] = [];

  for (let i = 0; i < count; i++) {
    // 다양한 레벨을 랜덤으로 배분
    const level = levels[Math.floor(Math.random() * levels.length)];
    const template = LOG_TEMPLATES[level];
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
 * 로그를 도메인별 경로 구조로 S3에 업로드합니다.
 *
 * 새 경로 형식:
 *   s3://bucket/seungjae/{domain}/{year}/{month}/{day}/mock-batch-xxx.json
 *
 * 왜 JSON Lines 포맷인가?
 * - Athena가 JSON SerDe (org.openx.data.jsonserde.JsonSerDe)로 읽을 수 있습니다.
 * - 한 줄에 하나의 JSON 객체 = 한 로그 레코드
 * - Glue 테이블의 InputFormat을 JSON으로 맞춰야 합니다.
 */
async function uploadLogsToS3(logs: LogEntry[]): Promise<number> {
  // 로그를 도메인/날짜별로 그룹핑
  const partitions = new Map<string, LogEntry[]>();

  for (const log of logs) {
    const date = new Date(log.timestamp);
    const year = date.getFullYear().toString();
    const month = (date.getMonth() + 1).toString().padStart(2, "0");
    const day = date.getDate().toString().padStart(2, "0");

    // 새 경로: {base_prefix}{domain}/{year}/{month}/{day}/
    const key = `${config.s3.base_prefix}${log.domain}/${year}/${month}/${day}`;
    if (!partitions.has(key)) {
      partitions.set(key, []);
    }
    partitions.get(key)!.push(log);
  }

  let uploadedFiles = 0;

  for (const [partitionPath, partitionLogs] of partitions) {
    // JSON Lines 포맷: 한 줄에 하나의 JSON 객체
    const jsonLines = partitionLogs
      .map((log) => JSON.stringify(log))
      .join("\n");

    const s3Key = `${partitionPath}/mock-batch-${Date.now()}.json`;

    await s3.send(
      new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: s3Key,
        Body: jsonLines,
        ContentType: "application/json",
      })
    );

    uploadedFiles++;
    console.log(`  uploaded ${s3Key} (${partitionLogs.length} records)`);
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

  // 로그 생성 (5개 도메인 x 100건 = 500건)
  const domains = config.domains.map((d) => d.name);
  const LOGS_PER_DOMAIN = 100;

  let totalLogs = 0;
  const allLogs: LogEntry[] = [];

  for (const domain of domains) {
    const logs = generateLogsForDomain(domain, LOGS_PER_DOMAIN);
    allLogs.push(...logs);
    totalLogs += logs.length;
    console.log(`  ${domain}: ${logs.length} records generated`);
  }

  console.log(`\nTotal ${totalLogs} logs generated\n`);

  // S3 업로드
  console.log("S3 업로드 시작...\n");
  const uploadedFiles = await uploadLogsToS3(allLogs);

  console.log(`\n=== Done ===`);
  console.log(`Total logs: ${totalLogs}`);
  console.log(`S3 files: ${uploadedFiles} (grouped by domain/date partition)`);
  console.log(`\nPath structure: s3://${config.s3.bucket}/${config.s3.base_prefix}{domain}/{year}/{month}/{day}/`);
  console.log(`\nNext: npx tsx scripts/test-athena-query.ts`);
}

main().catch((error: unknown) => {
  console.error("Mock 로그 생성 실패:", error);
  process.exit(1);
});

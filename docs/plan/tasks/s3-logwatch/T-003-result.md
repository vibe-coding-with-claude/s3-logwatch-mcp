# T-003 init-infra 구현 결과

## 생성/수정된 파일

| 파일 | 작업 | 설명 |
|------|------|------|
| `src/tools/init.ts` | 신규 생성 | init-infra MCP 도구 전체 구현 |
| `src/tools/index.ts` | 수정 | registerInitTool import 추가 및 registerTools()에서 호출 |
| `docs/plan/tasks/s3-logwatch/T-003-init-infra.task.md` | 수정 | Status를 done으로 변경 |

## 각 AWS 리소스의 역할

### 1. S3 Bucket
- 로그가 최종 저장되는 장소입니다.
- Hive 파티셔닝 구조(level/domain/year/month/day)로 디렉토리가 나뉘어 Athena 스캔량을 최소화합니다.
- Firehose가 Parquet 변환 후 이 버킷에 파일을 씁니다.

### 2. Glue Database (s3_logwatch)
- AWS Glue Data Catalog의 데이터베이스입니다.
- Athena가 테이블 메타데이터를 조회하는 곳입니다.
- Glue는 하이픈을 허용하지 않으므로 s3-logwatch -> s3_logwatch로 변환합니다.

### 3. Glue Table (logs)
- 로그 테이블의 스키마(컬럼, 타입)와 파티션 키를 정의합니다.
- Firehose가 Parquet 변환 시 이 테이블의 스키마를 참조합니다.
- Athena가 쿼리할 때 이 테이블 정의를 사용합니다.
- Partition Projection이 활성화되어 MSCK REPAIR TABLE 없이 새 파티션을 자동 인식합니다.

### 4. IAM Role (s3-logwatch-firehose-role)
- Firehose 서비스가 다른 AWS 리소스에 접근하기 위한 역할입니다.
- Trust Policy: firehose.amazonaws.com만 이 역할을 assume할 수 있습니다.
- Inline Policy에 포함된 권한:
  - S3: PutObject, GetObject, ListBucket, GetBucketLocation (로그 파일 쓰기)
  - Glue: GetTable, GetTableVersion, GetTableVersions, GetDatabase (Parquet 변환 시 스키마 조회)

### 5. Kinesis Data Firehose Delivery Stream
- CloudWatch Logs에서 수신한 JSON 로그를 Parquet으로 변환하여 S3에 저장합니다.
- 주요 설정:
  - DataFormatConversionConfiguration: JSON -> Parquet 변환 (Glue 테이블 스키마 참조)
  - DynamicPartitioning: 로그의 level, domain 필드값으로 S3 경로를 결정
  - MetadataExtraction: JQ 프로세서로 level, domain 필드를 추출
  - BufferingHints: config.yaml의 buffer_interval, buffer_size에 따라 S3에 기록
  - Prefix: Hive 파티셔닝 경로 (level=.../domain=.../year=.../month=.../day=.../)

### 6. Athena Workgroup (s3-logwatch)
- Athena 쿼리 실행 환경입니다.
- 쿼리 결과 저장 위치를 고정하여 일관성을 보장합니다.
- EnforceWorkGroupConfiguration으로 개별 쿼리의 설정 변경을 방지합니다.

## 멱등성 처리 방식

모든 리소스에 동일한 패턴을 적용합니다:

1. **확인**: 리소스가 이미 존재하는지 조회 API를 호출합니다.
2. **분기**: 존재하면 "exists"를 반환하고 스킵, 존재하지 않으면 3으로 진행합니다.
3. **생성**: 리소스 생성 API를 호출합니다.
4. **결과**: 성공하면 "created", 실패하면 "failed"를 반환합니다.

| 리소스 | 존재 확인 API | 없음 판단 에러 |
|--------|--------------|---------------|
| S3 Bucket | HeadBucket | NotFound, 404, NoSuchBucket |
| Glue Database | GetDatabase | EntityNotFoundException |
| Glue Table | GetTable | EntityNotFoundException |
| IAM Role | GetRole | NoSuchEntityException |
| Firehose Stream | DescribeDeliveryStream | ResourceNotFoundException |
| Athena Workgroup | GetWorkGroup | InvalidRequestException |

## IAM 권한 설계

최소 권한 원칙(Principle of Least Privilege)을 적용했습니다:

- **Trust Policy**: `firehose.amazonaws.com`만 역할을 assume 가능
- **S3 권한**: 특정 버킷과 그 하위 객체에만 제한 (`arn:aws:s3:::버킷명`, `arn:aws:s3:::버킷명/*`)
- **Glue 권한**: 특정 데이터베이스와 테이블에만 제한 (catalog, database, table ARN 명시)
- **Managed Policy 미사용**: 불필요한 권한을 피하기 위해 Inline Policy로 정확한 권한만 부여

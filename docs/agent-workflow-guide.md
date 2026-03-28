---
type: howto
tags: [claude-code, agent, workflow, pm, task, 5-agent-team]
---

# 에이전트 워크플로우 가이드

## 개요

Claude Code에서 5인 에이전트 팀으로 기능을 구현하는 방법.

전체 흐름:

```
[나] → [PM] → task 파일 생성 → [Infra/BE/FE/QA] → [PM] 검증
```

모든 작업은 PM(기획자)에서 시작하고 PM에서 끝난다.

## 방법

### 1단계: 기능 요청

PM에게 구현할 기능을 알려준다. 기능명 또는 설명으로 요청.

```
> @pm 회원가입 구현해줘.
```

**PM이 하는 일:**
- `docs/plan/specs/{domain}/{name}.md` 읽기
- `docs/plan/policy/{file}.md` 정책 교차 확인
- `docs/plan/pending-decisions.md` 블로커 확인
- 블로커가 있으면 나에게 보고
- `docs/plan/tasks/{domain}/{name}.task.md` 생성

### 2단계: 블로커 처리 (있을 경우)

PM이 보고: "블로커 — 인증 방식 미확정"

내 선택지:

```
> 블로커 무시하고 현재 가정값으로 진행해.
> 블로커 해결될 때까지 대기.
> 블로커 안 걸리는 부분만 먼저 진행해.
```

### 3단계: 에이전트별 작업 위임

task 파일이 생성되면, 각 에이전트에게 자기 섹션을 위임한다.

```
> @infra docs/plan/tasks/user/signup.task.md의 infra 섹션 실행해줘.
```

```
> @be docs/plan/tasks/user/signup.task.md의 be 섹션 실행해줘.
```

```
> @fe docs/plan/tasks/user/signup.task.md의 fe 섹션 실행해줘.
```

```
> @qa docs/plan/tasks/user/signup.task.md의 qa 섹션 실행해줘.
```

**권장 순서:**
1. 인프라 (DB 스키마, 리소스)
2. 백엔드 (API, 비즈니스 로직)
3. 프론트엔드 (UI, API 연동)
4. 테스트 (전체 검증)

### 4단계: 구현 검증

PM에게 스펙 대비 검증을 요청한다.

```
> @pm 회원가입 구현 결과 검증해줘.
```

**PM이 하는 일:**
- 구현 결과 vs 스펙 비교 (처리 흐름, 유효성, 예외 처리)
- 항목별 Pass/Fail 보고
- 통과 시 task 상태를 `done`으로 갱신

### 5단계: 이슈 수정

PM이 불일치를 보고하면:

```
> @be PM이 "이메일 중복 검사" 예외 처리 누락을 발견했어.
  docs/plan/specs/user/signup.md 예외 처리 테이블 확인해줘.
```

수정 후 PM에게 재검증 요청.

### 전체 예시 세션

```bash
# 1. task 생성
> @pm 게시글 작성 구현해줘.

# PM이 스펙 읽고, task 파일 생성, 블로커 없음 보고.

# 2. 인프라
> @infra docs/plan/tasks/board/post-create.task.md의 infra 섹션 실행해줘.

# 3. 백엔드
> @be docs/plan/tasks/board/post-create.task.md의 be 섹션 실행해줘.

# 4. 프론트엔드
> @fe docs/plan/tasks/board/post-create.task.md의 fe 섹션 실행해줘.

# 5. 테스트
> @qa docs/plan/tasks/board/post-create.task.md의 qa 섹션 실행해줘.

# 6. 검증
> @pm 게시글 작성 구현 결과 검증해줘.

# 7. 전체 통과 → 다음 기능으로
```

### 일괄 처리 (연관 기능 묶음)

관련 기능을 한번에 태스크로 만들 수 있다:

```
> @pm 게시판 관련 기능 전부 task 만들어줘:
  post-create, post-list, post-detail, post-edit, post-delete
```

의존성 순서는 PM이 task 파일에 명시해준다.

### 기획 문서 유지보수

스펙 수정, 블로커 해소, 내용 추가 등 모두 PM을 통해서 한다.

```bash
# 블로커 해소
> @pm 인증 방식 확정됐어. JWT로 간다. 스펙 반영해줘.

# 검토 필요 항목 확정
> @pm 비밀번호 최소 길이 8자로 확정. 스펙이랑 pending 둘 다 업데이트해줘.

# 스펙 내용 수정
> @pm 게시글 제목 글자수 제한을 100자에서 50자로 변경해줘.

# 새로운 미확정 사항 등록
> @pm 파일 업로드 최대 용량 제한이 필요할 수 있어. pending에 추가해줘.

# 정책 변경
> @pm 세션 유효시간을 변경해줘. 영향받는 스펙도 알려줘.

# 현재 상태 확인
> @pm pending-decisions.md에 블로커 몇 개 남았어?
```

PM이 알아서: 스펙 수정 → pending 동기화 → 영향 범위 보고 → task 파일 갱신까지 처리한다.

## 주의사항

- **항상 PM부터 시작한다.** 다른 에이전트를 스펙 파일로 직접 보내지 않는다.
- **한 기능씩 완료** 후 다음으로 넘어간다 (독립 기능이 아닌 이상).
- **에이전트가 헤매면** 구체적인 스펙 파일 경로를 알려준다.
- **스펙이 잘못되었으면** PM에게 스펙 먼저 수정하라고 한 뒤 재작업한다.
- **pending-decisions.md를 주기적으로 확인** — 해결된 항목이 기능 차단을 풀 수 있다.

# Task: CI/CD — GitHub Actions

> **Priority:** 🟢 P3
> **Status:** done

## infra
- [x] `.github/workflows/ci.yml` 생성
  - trigger: push, pull_request (main)
  - jobs: install → tsc --noEmit → test (vitest)
  - Node.js 20
- [x] 워크플로우 문법 검증

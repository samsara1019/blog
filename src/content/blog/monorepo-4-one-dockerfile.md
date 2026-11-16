---
title: '모노레포 4편. Dockerfile 하나로 모든 앱을 빌드하기'
description: '바뀐 앱만 빌드하는 구조, 캐시 4계층, 2.2GB를 덜어낸 런타임 이미지, 그리고 실제로 나아진 것.'
tags: ['모노레포', 'turborepo', 'docker', 'ci']
pubDate: 2026-11-16T00:02:00Z
---

## 전체 흐름

```
git push
  └─ CodePipeline: 경로 필터로 "어느 앱이 바뀌었나" 판단
       └─ CodeBuild: APP_NAME을 넘겨 docker build
            └─ 공용 Dockerfile: turbo run build --filter=APP_NAME...
                 └─ ECR에 이미지 push → ECS 서비스 갱신
```

## Dockerfile 4개를 1개로

처음에는 앱마다 Dockerfile이 있었다. 내용은 거의 같고 앱 이름만 달랐다. 한 곳을 고치면 나머지 세 곳도 고쳐야 했고, 빼먹어서 앱마다 빌드 방식이 조금씩 달라졌다. 레포를 합쳤는데 멀티 레포의 문제를 그대로 들고 온 셈이다.

빌드 인자 하나로 대상을 정하는 공용 파일로 합쳤다.

```bash
docker build --build-arg APP_NAME=service-a -f docker/Dockerfile .
```

## turbo.json

```json
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["apps/*/.nuxt/**", "apps/*/.output/**", "packages/*/dist/**"]
    },
    "dev": { "cache": false, "persistent": true },
    "lint": { "outputs": [] },
    "test": { "outputs": [] }
  }
}
```

- `^build`: 내가 의존하는 워크스페이스의 build를 먼저 실행한다
- `outputs`: 캐시가 맞았을 때 복원할 결과물 경로다. 빠뜨리면 캐시는 맞는데 결과물이 없는 상태가 된다
- `cache: false`: dev 서버처럼 계속 도는 태스크는 캐시하지 않는다

## 변경 감지와 범위 빌드는 다른 층이다

가장 오래 헷갈린 부분이다. "앱별로 변경을 추적해서 그 앱만 빌드한다"는 일을 Turbo가 한다고 생각했다. 아니다.

| 층 | 위치 | 하는 일 |
| --- | --- | --- |
| 변경 감지 | CodePipeline의 경로 필터 (레포 밖) | `apps/service-a/**`가 바뀌면 service-a 빌드를 시작한다 |
| 범위 빌드 | 공용 Dockerfile | 넘겨받은 `APP_NAME`으로 그 앱과 의존 패키지만 빌드한다 |

범위를 정하는 줄은 하나다.

```dockerfile
RUN pnpm turbo run build --filter=${APP_NAME}...
```

`...`이 "이 앱과 이 앱이 의존하는 패키지"를 뜻한다. 다른 앱은 그래프에서 빠져 실행조차 되지 않는다.

Turbo가 하는 일은 셋이다. 의존 순서, 범위 선택, 캐시. 변경 감지는 하지 않는다.

### 어디를 고치면 무엇이 빌드되나

| 고친 곳 | 빌드되는 앱 |
| --- | --- |
| `apps/service-a/**` | service-a |
| `packages/**` | 전부 |
| `docker/Dockerfile`, `turbo.json`, lockfile | 전부 |
| `docs/**`, `*.md` | 없음 |

`packages/**`를 고치면 전부 빌드된다. 경로 필터는 어느 앱이 그 패키지에 의존하는지 모르기 때문이다.

개선안은 있다. `turbo --filter='...[origin/main]'`로 git diff와 의존 그래프를 함께 보면 실제로 영향받는 앱만 고를 수 있다. 아직 하지 않았다. 이유는 세 가지다.

- 틀린 결과(누락)는 없고 과잉만 있다
- 원격 캐시를 붙이면 영향 없는 앱의 빌드는 캐시에서 복원된다. 지금은 붙어 있지 않아 이 근거는 아직 성립하지 않는다 (5편 6번)
- 앱끼리 import가 없어 "영향받는 앱"이 거의 항상 전부 아니면 하나다. 정밀하게 골라도 아끼는 양이 작다

## Dockerfile에서 배운 것 네 가지

### 워크스페이스의 `package.json`을 전부 복사해야 한다

Docker 레이어 캐시를 살리려고 소스보다 `package.json`을 먼저 복사하고 설치한다. 이때 대상 앱의 것만 복사하면 안 된다.

```dockerfile
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/config/package.json  ./packages/config/package.json
COPY packages/ui/package.json      ./packages/ui/package.json
# ... 모든 패키지
COPY apps/${APP_NAME}/package.json ./apps/${APP_NAME}/package.json

RUN pnpm install --frozen-lockfile
```

일부만 복사하면 pnpm이 그 패키지를 워크스페이스 멤버로 인식하지 못해 링크하지 않는다. 설정 패키지가 링크되지 않으면 `tsconfig`의 `extends`를 해석하지 못해 빌드가 깨진다.

비용이 있다. 패키지를 추가하거나 지울 때 이 목록도 함께 고쳐야 한다. 실제로 지운 패키지의 COPY 줄을 남겨 둬서 빌드가 깨진 적이 있다.

### 런타임 이미지에서 `node_modules` 2.2GB를 뺐다

처음에는 빌드 결과물과 함께 루트 `node_modules`를 통째로 런타임 이미지에 넣었다. 모노레포 전체의 의존성이라 약 2.2GB였다.

Nuxt(Nitro)의 node-server 결과물은 자립형이다. 서버가 실제로 쓰는 의존성만 추적해 `.output/server/node_modules`에 넣는다. `node .output/server/index.mjs`만으로 실행된다. 루트 `node_modules`는 런타임에 한 번도 쓰이지 않는 무게였다.

```dockerfile
COPY --from=builder /app/apps/${APP_NAME}/.output ./.output
CMD ["node", ".output/server/index.mjs"]
```

단순히 용량이 아까운 문제가 아니었다. 이미지가 커지면서 컨테이너 호스트의 디스크가 차서 새 이미지를 받지 못하는 장애(`CannotPullContainerError: no space left on device`)가 났다.

### 메모리 상한은 두 번 정한다

빌드할 때와 실행할 때 각각 필요하다.

```dockerfile
# 빌드: 서버 번들 단계에서 메모리 부족으로 죽지 않게 올린다
ENV NODE_OPTIONS="--max-old-space-size=7168"

# 실행: 컨테이너 메모리 한도(4GiB)의 약 75%
ENV NODE_OPTIONS="--max-old-space-size=3072"
```

실행 쪽 상한을 정하지 않으면 V8이 상한 없이 힙을 키우다가 컨테이너 한도에 걸려 강제 종료된다. 이 경우 힙 에러도 스택 트레이스도 남지 않는다. 로그 없이 죽는 프로세스의 원인 중 하나다.

### 유닛 테스트는 세 군데서 돌리도록 설계했다

| 시점 | 범위 | 수단 |
| --- | --- | --- |
| 커밋 | 바뀐 패키지만 | husky pre-commit. `turbo run test --filter='...[HEAD]'` |
| 푸시 | 전체 패키지 | husky pre-push. `turbo run test --filter='./packages/*'` |
| 이미지 빌드 | 전체 패키지 | Dockerfile의 테스트 단계 |

앞의 둘은 조기 경보다. 전체 테스트가 3초쯤 걸리고 캐시가 맞으면 1초 안에 끝나서 훅에 넣어도 부담이 없다. 다만 `--no-verify`로 건너뛸 수 있다. 그래서 세 번째를 최종 차단선으로 뒀다.

```dockerfile
FROM node:22-alpine AS unit-test
COPY --from=base /app ./
RUN pnpm turbo run test --filter='./packages/*' && touch /app/.unit-test-ok
```

설치와 소스는 앞 단계의 것을 그대로 복사하므로 다시 설치하지 않는다. 테스트가 통과하면 표시 파일을 만들고, 최종 단계가 그 파일을 가져가게 해서 "테스트 실패 = 이미지 빌드 실패"로 만드는 설계다.

**그런데 이 단계는 실행되지 않고 있었다.** 최종 단계에 표시 파일을 가져가는 줄이 빠져 있었다. 지금 유닛 테스트를 실제로 돌리는 것은 husky뿐이다. 자세한 내용은 5편 7번에 쓴다.

pre-commit 훅에는 하나가 더 들어 있다. 커밋에 `package.json` 변경이 있으면 `pnpm install --lockfile-only`로 lockfile을 맞춰 함께 스테이징한다. "package.json만 고치고 lockfile을 빼먹어서 CI의 `--frozen-lockfile`이 실패"하는 일을 막는다.

## 캐시 4계층

| 계층 | 위치 | 범위 | 상태 |
| --- | --- | --- | --- |
| 1 | CI 인스턴스의 pnpm 저장소 | 인스턴스 단위 | 동작 |
| 2 | BuildKit 캐시 마운트 (pnpm 저장소, `.turbo`) | 같은 빌드 호스트 | 호스트가 유지될 때만 |
| 3 | Turborepo 원격 캐시 | 팀과 CI 전체 | 연결되지 않음 |
| 4 | 이미지 레지스트리의 레이어 캐시 (`--cache-from`) | 같은 앱의 이전 이미지 | 동작 |

팀 문서는 3번을 핵심이라고 적었다. 실제로는 3번이 연결돼 있지 않았다(5편 6번). 아래 빌드 시간은 원격 캐시 없이 나온 값이다.

원격 캐시가 붙으면 이렇게 동작한다.

1. 입력(소스, lockfile, 환경변수)을 해시한다
2. 캐시 서버에서 같은 해시를 찾는다
3. 있으면 결과물을 내려받고 빌드를 건너뛴다
4. 없으면 빌드하고 결과를 올린다

CI가 빌드한 결과를 동료의 로컬에서 다시 쓰게 된다.

붙어 있는지는 Turbo가 실행을 시작할 때 찍는 한 줄로 안다. `Remote caching disabled`가 보이면 붙지 않은 것이다.

캐시가 안 맞을 때는 해시부터 본다.

```bash
pnpm turbo run build --filter=service-a... --dry-run=json | jq '.tasks[] | {taskId, hash, cache}'
```

흔한 원인은 `turbo.json`의 `inputs`나 `globalEnv`에 잡히지 않은 변경이다.

## PR 프리뷰

본배포는 그대로 두고 PR 프리뷰만 AWS Amplify로 붙였다. 모노레포의 SSR 앱이라 몇 군데서 막혔다. 요점만 적는다.

- **`Illegal path found for appRoot`**: clone 직후에 나면 빌드 설정이 아니라 경로 문제다. 앱 루트는 레포 이름을 뺀 `apps/service-b` 형태여야 한다
- **pnpm 링커**: Amplify는 pnpm 워크스페이스에서 hoisted 링커를 요구한다. 로컬 동작을 바꾸지 않으려고 빌드 중에만 `.npmrc`에 넣었다
- **빌드 명령**: `turbo run build`로는 SSR 결과물이 나오지 않는다. `NITRO_PRESET=aws-amplify pnpm --filter <앱> build`로 지정한다
- **환경변수 상속**: 프리뷰는 base 브랜치의 환경변수를 그대로 물려받는다. base가 운영 API를 가리키면 모든 PR 프리뷰가 운영 데이터를 쓴다

자세한 과정은 따로 쓴다.

## 무엇이 나아졌나

### 빌드 시간

팀 문서에 적힌 값이다.

| 상황 | 시간 |
| --- | --- |
| 캐시 없음 | 약 11분 |
| 코드 변경 없음 | 약 1.5분 |
| 앱 하나만 변경 | 약 5분 |

AWS CodeBuild에 기록된 빌드 시간으로 쟀다. 모노레포로 옮기기 전과 비교하면 평균 30~50% 줄었다.

이 값은 원격 캐시 없이 나온 것이다. 줄어든 시간은 범위 빌드, Docker 레이어 캐시, BuildKit 캐시 마운트가 만들었다. 원격 캐시를 붙이면 "앱 하나만 변경"의 5분이 더 줄어들 여지가 있다.

앱별 전후 비교표는 싣지 않는다. 30~50%는 CodeBuild 기록을 보고 낸 평균이다. 전환을 준비하고 있다면 옮기기 전에 앱별 빌드 시간을 표로 적어 두기를 권한다. 나중에 "얼마나 빨라졌나"라는 질문을 반드시 받는다.

### 수치로 잡히지 않는 것

- **공유 화면이 진짜 컴포넌트가 됐다.** 스크롤 핸드셰이크, 모달이 갇히는 문제, 뒤로가기 동기화 코드가 필요 없어졌다. `postMessage`와 메시지 리스너 코드가 90개 파일 234줄에서 테스트를 빼고 2줄로 줄었다
- **공통 코드 수정이 PR 하나로 끝난다.** 예전에는 같은 수정을 레포마다 올렸다
- **빌드 설정을 한 곳에서 고친다.** Node 버전을 올릴 때 Dockerfile 하나만 고쳤다
- **컨테이너와 배포 파이프라인이 하나 줄었다.** 공통 iframe 앱이 내려갔다
- **의존성 버전이 한 곳에 있다**

### 나빠진 것

- 공용 패키지를 고치면 모든 앱이 빌드된다
- 공유 패키지의 의존성이 앱 빌드를 깬다 (5편)
- 한 사람의 `node_modules` 문제가 모든 앱의 개발을 막는다 (5편)
- Dockerfile의 COPY 목록처럼 손으로 맞춰야 하는 곳이 생겼다
- 설정이 한곳에 모이자 "문서에는 있는데 실제로는 안 도는 것"도 한곳에 숨었다 (5편 6번, 7번)

## 기억할 점

- **Turbo는 변경을 감지하지 않는다.** "왜 내 앱이 빌드됐지"는 레포가 아니라 파이프라인의 경로 필터에서 찾는다
- **과잉 빌드는 누락보다 싸다.** 정밀한 변경 감지는 누락이 없다는 확신이 선 뒤에 한다
- **런타임 이미지에는 실행에 필요한 것만 넣는다.** 프레임워크가 자립형 결과물을 만들어 주는지 먼저 확인한다
- **컨테이너에서는 힙 상한을 직접 정한다.** 정하지 않으면 흔적 없이 죽는다
- **`package.json`을 먼저 복사하는 최적화는 모노레포에서 "전부" 복사해야 성립한다**
- **설정을 하나로 합치는 것이 모노레포의 실제 이득이다.** Dockerfile을 4개로 둔 동안은 레포만 하나였다
- **빌드 시간은 "무엇 덕분에 줄었는지"까지 확인한다.** 원격 캐시 덕분이라고 믿었지만 원격 캐시는 붙어 있지 않았다

## 모노레포 시리즈

1. [iframe으로 공유하던 화면을 import로 바꾸기까지](/blog/monorepo-1-iframe-to-import/)
2. [Nx가 아니라 Turborepo를 고른 이유](/blog/monorepo-2-turborepo-vs-nx/)
3. [레포 5개를 히스토리째 하나로 합치기](/blog/monorepo-3-merge-repos/)
4. **Dockerfile 하나로 모든 앱을 빌드하기** (이 글)
5. [모노레포에서 실제로 밟은 지뢰들](/blog/monorepo-5-troubleshooting/)

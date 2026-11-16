---
title: '모노레포에서 실제로 밟은 지뢰들'
description: 'pnpm, 공유 패키지 의존성, git 훅, Docker 빌드, 환경변수에서 겪은 문제와 원인.'
tags: ['모노레포', 'pnpm', '트러블슈팅']
pubDate: 2026-11-16T00:01:00Z
---

각 항목은 증상, 원인, 해결, 배운 것 순서다.

## 1. `pnpm install`은 "Already up to date"인데 모듈이 없다

**증상.** 서로 관계없어 보이는 에러가 연달아 났다.

| 순서 | 에러 | 실제 원인 |
| --- | --- | --- |
| 1 | 폰트 SCSS 파일 `MODULE_NOT_FOUND` | SCSS 컴파일러가 의존하는 패키지에 `.map`만 남고 `.js`가 없었다 |
| 2 | devtools 내부 파일 없음 | 같은 손상 |
| 3 | SSR 500 | 다른 패키지 안의 빈 폴더가 실제 의존성을 가렸다 |
| 4 | 다른 앱의 postinstall 실패 | 같은 손상 |

**원인.** pnpm은 lockfile과 메타데이터로 설치 여부를 판단한다. 패키지 안의 파일이 실제로 있는지는 보지 않는다. 그래서 손상된 상태에서도 "Already up to date"가 나온다.

에러 메시지도 헷갈리게 한다. 에러는 "처음 로드를 시도한 파일"의 이름으로 찍힌다. SCSS 파일은 멀쩡했고, 깨진 것은 컴파일러의 의존성이었다. SSR 실패는 브라우저에 500만 보이고 실제 스택은 dev 서버 터미널에만 찍힌다.

**해결.** 패키지를 하나씩 고치지 않고 전체를 다시 설치한다.

1. dev 서버를 먼저 끈다
2. 루트, `apps/*`, `packages/*`의 `node_modules`와 `apps/*/.nuxt`를 지운다
3. `pnpm install`을 두 번 실행한다. 두 번째에 추가 설치가 없어야 끝이다. 실제로 두 번째 실행에서 40개가 더 붙었다

**dev 서버를 켠 채 재설치하면 안 된다.** Vite의 의존성 사전 번들이 세션 중간에 다시 만들어져, 브라우저에 pinia가 두 벌 로드된다. 플러그인은 한쪽에 등록되고 스토어는 다른 쪽을 봐서 "no active Pinia"가 난다.

**배운 것.**

- 서로 다른 패키지에서 `MODULE_NOT_FOUND`가 두 건 이상 나면 부분 수리를 그만둔다
- 손상 범위는 비슷한 시각에 만들어진 빈 폴더를 찾으면 보인다
- 모노레포에서는 `node_modules`가 여러 층이라 손상이 여러 앱에 동시에 나타난다

## 2. 공유 패키지의 의존성 한 줄이 앱 빌드를 깬다

**증상.** dependabot의 묶음 PR을 머지한 뒤 앱 두 개의 `nuxt build`가 `toDevtoolsGroupId is not exported`로 실패했다. 앱의 `package.json`은 바뀌지 않았다.

**원인.** 공유 패키지 하나만 `vue-i18n`이 9에서 11로 올라갔다.

1. 공유 패키지가 `vue-i18n@11`을 가져오면 `@intlify/core-base@11`이 함께 설치된다
2. 호스트 앱의 `@nuxtjs/i18n@8`은 Nuxt alias로 `@intlify/shared`를 vue-i18n 9가 쓰는 경로 하나로 고정한다
3. `core-base@11`이 `shared@9`를 보게 된다. 11에만 있는 export가 없어 빌드가 깨진다

alias는 버전별로 나뉘지 않는다. 한 빌드 안에 메이저가 둘이면 한쪽은 반드시 틀린 버전을 본다.

**해결.** 호스트의 `@nuxtjs/i18n`을 올리기 전까지 공유 패키지도 9.x로 둔다.

되돌림 커밋을 어디에 두는지도 중요했다. 개발 브랜치에 직접 커밋하지 않고 dependabot PR 브랜치에 올렸다. PR 브랜치가 그대로면 같은 PR이 운영 브랜치로 갈 때 bump가 다시 들어간다.

**배운 것.**

- 공유 패키지의 의존성도 호스트의 빌드 그래프에 들어온다. 앱의 `package.json`이 그대로여도 안전하지 않다
- 프레임워크 모듈이 감싸고 있는 라이브러리는 그 모듈의 메이저에 묶인다. 올리는 순서는 호스트 모듈이 먼저다
- dependabot 묶음 PR은 워크스페이스마다 다른 버전을 만들 수 있다. 묶음 안에 프레임워크 관련 패키지가 있으면 호스트와 공유 패키지의 메이저가 같은지 본다

## 3. 설치한 git 훅이 한 번도 실행되지 않았다

**증상.** `.git/hooks/pre-push`에 보안 검사 훅을 설치했다. 설치 스크립트는 "완료"를 찍었지만 검사는 한 번도 실행되지 않았다.

**원인.** git은 훅 폴더를 한 곳만 본다. husky가 `core.hooksPath`를 `.husky/_`로 바꾸면 기본 폴더 대신 그 폴더만 본다. 두 폴더를 합쳐 보지 않는다.

```
git push
  └─ core.hooksPath = .husky/_
       └─ .husky/pre-push (유닛 테스트)      실행됨
  .git/hooks/pre-push (보안 검사)             아무도 부르지 않음
```

**해결.** husky 쪽 훅에서 `.git/hooks`의 훅을 있으면 부르게 했다.

```sh
security_hook="$(git rev-parse --git-common-dir)/hooks/pre-push"
if [ -x "$security_hook" ]; then
  "$security_hook" "$@" || exit 1
fi
```

- `git rev-parse --git-path hooks/pre-push`를 쓰면 `core.hooksPath`를 따라가 husky 자신을 가리킨다. 무한 재귀가 된다. `--git-common-dir`로 실제 `.git`을 잡는다
- `-x` 검사 덕분에 설치하지 않은 팀원은 영향이 없다
- 검사 로직을 복사하지 않고 호출만 한다. 원본이 갱신되면 그대로 반영된다

**배운 것.**

- "설치 완료"는 "실행됨"이 아니다. 훅은 일부러 실패시켜 봐야 도는지 안다
- 훅이 안 돌면 `git config core.hooksPath`부터 본다. husky, lefthook, simple-git-hooks 모두 같다
- husky는 지금 체크아웃된 브랜치의 훅을 실행한다. 머지 전에 딴 브랜치는 변경을 받기 전까지 검사가 빠진다

## 4. Docker 빌드에서만 설정 패키지를 못 찾는다

4편의 "`package.json`을 전부 복사해야 한다"를 문제 상황으로 다시 쓴다.

**증상.** 로컬 빌드는 되는데 Docker 빌드에서 설정 패키지를 찾지 못하고 `tsconfig`의 `extends` 해석이 실패한다.

**원인.** Dockerfile의 COPY 목록에 새 패키지의 `package.json`이 빠졌다. pnpm이 그 패키지를 워크스페이스 멤버로 인식하지 못했다.

**반대 경우도 있다.** 패키지를 지웠는데 COPY 줄이 남아 있으면 파일이 없어 빌드가 깨진다.

**배운 것.** 패키지를 추가하거나 지우는 절차에 "Dockerfile의 COPY 목록 갱신"을 넣는다. 손으로 맞추는 목록은 반드시 어긋나므로, 가능하면 자동화한다.

**이 목록을 없애는 방법이 있다.** `turbo prune <앱> --docker`는 그 앱을 빌드하는 데 필요한 워크스페이스만 골라 `out/` 폴더에 내놓는다.

```
out/json/   필요한 package.json들과 그 앱에 맞게 잘라낸 lockfile
out/full/   필요한 워크스페이스의 소스 전체
```

Docker의 두 단계 복사에 그대로 맞는 모양이다.

```dockerfile
FROM node:22-alpine AS pruner
WORKDIR /app
COPY . .
RUN pnpm dlx turbo prune ${APP_NAME} --docker

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .          # package.json과 lockfile만
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .          # 소스
RUN pnpm turbo run build --filter=${APP_NAME}...
```

얻는 것은 두 가지다.

- 손으로 맞추는 COPY 목록이 사라진다. 패키지를 추가해도 Dockerfile을 고치지 않는다
- lockfile이 앱별로 잘려서, 다른 앱의 의존성이 바뀌어도 이 앱의 설치 레이어 캐시가 깨지지 않는다

아직 적용하지 않았다. 다음 개선 후보로 적어 둔다.

## 5. 런타임에 넣은 환경변수가 무시된다

모노레포에만 있는 문제는 아니다. 공용 Dockerfile이 빌드 인자를 `APP_NAME` 하나만 받는 구조에서 드러났다.

**증상.** 배포 환경에 환경변수를 정확히 넣었는데 서버가 "설정되지 않았다"고 한다. 클라우드 쪽 설정은 정상이었다.

**원인.** `nuxt.config.ts`의 `process.env.X`는 docker build 시점에 한 번 평가돼 이미지에 굳는다.

```ts
runtimeConfig: {
  githubReadToken: process.env.GITHUB_READ_TOKEN,   // 빌드 중에 읽는다. 빈 값으로 굳는다
  public: {
    apiUrl: process.env.NUXT_PUBLIC_API_URL,        // 이름이 규칙을 따라서 런타임에 덮인다
  },
}
```

Nuxt 3는 서버가 뜰 때 `runtimeConfig`의 키를 `NUXT_` + 대문자 스네이크 표기로 환경변수에서 찾아 덮어쓴다. 런타임에 덮어쓰는 방법은 이것 하나뿐이다.

기존 변수들이 잘 돌던 이유는 처음부터 `NUXT_PUBLIC_*`로 이름을 지었기 때문이다. 새로 추가한 키만 규칙을 따르지 않았다. 로컬 dev는 부팅할 때 평가해서 접두사 없이도 돌아간다. 그래서 운영에서만 터진다.

**해결.** 배포 설정의 환경변수 이름만 바꾼다. 코드와 비밀값 저장소의 이름은 그대로 둔다.

| runtimeConfig 키 | 환경변수 이름 |
| --- | --- |
| `githubReadToken` | `NUXT_GITHUB_READ_TOKEN` |

**배운 것.**

- 이미지에 환경변수를 굽지 않는 구조에서는 "언제 평가되는가"가 전부다
- `.env.example`에 운영에서 쓰는 이름(`NUXT_*`)으로 적어 두면 로컬과 운영이 한 이름으로 통한다
- 로컬에서 되고 운영에서 안 되면 빌드 시점과 실행 시점의 차이를 먼저 의심한다

## 6. 원격 캐시를 쓰는 줄 알았는데 연결된 적이 없었다

이 글을 쓰려고 설정을 다시 읽다가 찾았다.

**증상.** 증상이 없었다. 그것이 문제였다. 팀 문서에는 "S3 원격 캐시로 팀 전체가 캐시를 공유한다"고 적혀 있었고 빌드도 잘 됐다.

**원인.** 빌드 명령이 이랬다.

```dockerfile
RUN pnpm turbo run build --filter=${APP_NAME}... -- --remote-cache=${TURBO_REMOTE_URL}
```

`--` 뒤의 인자는 Turbo가 받지 않는다. 각 패키지의 빌드 스크립트로 그대로 넘어간다. dry run으로 확인할 수 있다.

```bash
pnpm turbo run build --filter=service-a... --dry-run=json -- --remote-cache=s3://x \
  | jq '.tasks[] | {taskId, command, cliArguments, cache}'
```

```json
{
  "taskId": "service-a#build",
  "command": "nuxt build",
  "cliArguments": ["--remote-cache=s3://x"],
  "cache": { "local": false, "remote": false, "status": "MISS" }
}
```

실제로 실행되는 것은 `nuxt build --remote-cache=s3://...`다. Nuxt는 모르는 인자를 무시한다. 에러가 나지 않으니 아무도 몰랐다.

애초에 Turbo에는 S3 주소를 직접 받는 옵션이 없다. 원격 캐시는 HTTP 캐시 서버와 환경변수 세 개(`TURBO_API`, `TURBO_TEAM`, `TURBO_TOKEN`)로 붙는다(2편). 저장소 어디에도 그 변수가 없었다.

**해결(예정).**

1. S3를 저장소로 쓰는 캐시 서버를 띄운다
2. 빌드에 `TURBO_API`와 `TURBO_TEAM`을 넘긴다. 토큰은 빌드 인자가 아니라 build secret으로 넘긴다. 빌드 인자는 이미지 이력에 남는다
3. 쓸모없는 `-- --remote-cache=...`를 지운다

여기까지는 저장소의 설정과 dry run으로 확인한 내용이다. CI에서도 같은지는 빌드 로그 첫머리에서 볼 수 있다. Turbo는 실행을 시작할 때 원격 캐시 상태를 한 줄로 찍고, 붙어 있지 않으면 `Remote caching disabled`라고 나온다.

**배운 것.**

- 무시되는 옵션은 에러를 내지 않는다. `--` 뒤에 붙인 인자는 누가 받는지 확인한다
- "캐시가 동작한다"는 빌드가 성공한다는 뜻이 아니다. 캐시 적중 여부를 로그에서 직접 본다
- 문서는 의도를 적은 것이다. 동작은 설정과 로그에 있다

## 7. 테스트 게이트가 한 번도 실행되지 않았다

역시 글을 쓰다가 찾았다.

**증상.** Dockerfile에 유닛 테스트 단계가 있고, 주석에는 "테스트 실패 = 이미지 빌드 실패"라고 적혀 있었다. 훅의 주석도 "최종 차단은 Docker 테스트 단계"라고 했다.

**원인.** BuildKit은 최종 단계가 참조하지 않는 단계를 실행하지 않는다. 테스트 단계가 만드는 표시 파일을 최종 단계가 가져가야 하는데, 그 `COPY` 줄이 빠져 있었다.

같은 모양의 작은 Dockerfile로 재현했다. 테스트 단계에 일부러 실패하는 명령을 넣었다.

```dockerfile
FROM alpine AS unit-test
RUN echo "RUNNING TESTS" && false && touch /.unit-test-ok

FROM alpine AS runner
COPY --from=builder /out.txt /out.txt
```

| 최종 단계 | 결과 |
| --- | --- |
| 표시 파일을 가져가지 않음 | 테스트 단계가 실행되지 않고 빌드 성공 |
| `COPY --from=unit-test /.unit-test-ok ...` 추가 | 테스트 단계가 실행되고 빌드 실패 |

**해결.** 최종 단계에 한 줄을 넣는다.

```dockerfile
COPY --from=unit-test /app/.unit-test-ok /tmp/.unit-test-ok
```

위 재현은 로컬에서 같은 구조의 Dockerfile로 한 것이다. CI에서는 빌드 로그에 테스트 러너의 출력이 있는지로 확인한다. 한 줄을 넣은 뒤에는 테스트를 일부러 하나 깨뜨려서 빌드가 멈추는지까지 본다.

**배운 것.**

- 게이트는 일부러 실패시켜 봐야 게이트인지 안다. 3번의 git 훅과 같은 교훈이다
- 멀티 스테이지 빌드에서 "단계를 정의했다"와 "단계가 실행된다"는 다르다
- 우회할 수 있는 검사(훅)만 남아 있었다. 최종 차단선이 없는 상태로 몇 달을 지냈다

## 8. 그 밖에 짧게

| 증상 | 원인과 해결 |
| --- | --- |
| 설치 후 `@acme/ui` import에 빨간 줄 | TypeScript 서버를 재시작한다 |
| 워크스페이스 패키지에서 새로 쓴 Tailwind 임의값(`pt-[1.625rem]`)이 dev에서 안 먹는다 | 링크된 패키지에서 처음 등장한 임의값은 실행 중인 dev 서버가 CSS를 만들어 주지 않는다. 표준 유틸은 먹고 임의값만 안 먹으면 이 경우다. dev 서버를 재시작하면 확인된다. 패키지 쪽의 픽셀 단위 배치는 SFC의 scoped CSS로 쓴다 |
| 긴 빌드 끝에 이미지 push가 `authorization token has expired` | 레지스트리 토큰은 12시간 유효하다. push 직전에 다시 로그인한다 |
| 빌드 중 메모리 부족 | 힙 상한을 올린다 (4편) |

## 기억할 점

- **모노레포의 문제는 대부분 "경계가 사라져서" 생긴다.** 한 패키지의 의존성, 한 사람의 `node_modules`, 한 줄의 설정이 모든 앱에 닿는다
- **에러 메시지가 가리키는 파일은 원인이 아닐 때가 많다.** 서로 다른 곳에서 같은 종류의 에러가 나면 공통 원인을 찾는다
- **"통과했다"와 "검사했다"는 다르다.** `pnpm install`의 "up to date", 훅 설치의 "완료", 실행되지 않는 테스트 단계, 무시되는 캐시 옵션이 모두 그랬다
- **글을 쓰는 일이 점검이 된다.** 6번과 7번은 이 글을 쓰려고 설정을 다시 읽다가 찾았다
- **로컬과 운영의 차이는 대개 평가 시점의 차이다**

## 참고 링크

- [Turborepo Docker 가이드](https://turborepo.com/docs/guides/tools/docker)

## 모노레포 시리즈

1. [iframe으로 공유하던 화면을 import로 바꾸기까지](/blog/monorepo-1-iframe-to-import/)
2. [Nx가 아니라 Turborepo를 고른 이유](/blog/monorepo-2-turborepo-vs-nx/)
3. [레포 5개를 히스토리째 하나로 합치기](/blog/monorepo-3-merge-repos/)
4. [Dockerfile 하나로 모든 앱을 빌드하기](/blog/monorepo-4-one-dockerfile/)
5. **모노레포에서 실제로 밟은 지뢰들** (이 글)

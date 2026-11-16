---
title: '저장소마다 다른 GitHub 계정으로 푸시하기'
pubDate: 2026-11-16
tags: ['git', 'github']
---

회사 계정과 개인 계정을 한 컴퓨터에서 같이 쓰면, 개인 저장소에 푸시할 때 이런 에러를 만난다.

```
remote: Permission to personal-account/blog.git denied to work-account.
fatal: unable to access 'https://github.com/personal-account/blog.git/': The requested URL returned error: 403
```

## 원인

git은 HTTPS 푸시에 쓸 계정을 저장소 주인을 보고 고르지 않는다. 자격 증명 도우미(credential helper)가 `github.com`에 대해 내주는 토큰을 그대로 쓴다. 도우미가 회사 계정의 토큰을 내주면 개인 저장소에도 회사 계정으로 푸시한다.

`gh`에 두 계정이 모두 로그인돼 있어도 마찬가지다. `gh`는 "활성 계정" 하나의 토큰만 내준다.

```bash
gh auth status    # 로그인된 계정과 활성 계정을 보여준다
```

`gh auth switch`로 활성 계정을 바꾸면 풀리지만, 회사 저장소로 돌아갈 때마다 다시 바꿔야 한다.

## 해결: 이 저장소에서만 다른 토큰을 쓴다

저장소 안에서 실행한다. `--local`이라 이 저장소의 `.git/config`에만 들어간다.

```bash
# 1. 전역에서 물려받은 도우미 목록을 이 저장소에서는 비운다
git config --local credential.helper ''

# 2. 개인 계정의 토큰을 내주는 도우미를 추가한다
git config --local --add credential.helper \
  '!f() { test "$1" = get && echo username=personal-account && echo "password=$(gh auth token --user personal-account)"; }; f'
```

- `gh auth token --user <계정>`은 활성 계정과 상관없이 그 계정의 토큰을 출력한다
- 값이 `!`로 시작하면 git은 그것을 셸 명령으로 실행한다. git이 자격 증명을 물을 때(`get`)만 사용자 이름과 토큰을 답한다
- 1번이 필요한 이유가 있다. 도우미는 여러 개가 순서대로 불리는데, 빈 값을 넣으면 그 앞의 목록이 지워진다. 빼면 전역 도우미가 먼저 회사 계정의 토큰을 내준다

토큰이 파일에 저장되지 않는다. 푸시할 때마다 `gh`에서 꺼내 온다.

## 확인

```bash
git config --local --get-all credential.helper   # 빈 줄 하나와 위 함수가 보인다
git push
```

전역 설정과 `gh`의 활성 계정은 그대로다. 다른 저장소는 이전처럼 동작한다.

## 알아둘 점

- `gh auth login`으로 두 계정이 모두 로그인돼 있어야 한다
- SSH로 푸시한다면 이 방법이 아니라 `~/.ssh/config`에 호스트 별칭을 두 개 만드는 쪽이다
- 커밋에 찍히는 이름과 이메일은 별개다. `git config --local user.email`로 따로 맞춘다

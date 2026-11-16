---
title: 'Astro content collection은 폴더 하나가 테이블 하나'
pubDate: 2026-11-16
tags: ['astro']
---

`src/content.config.ts`에 컬렉션을 정의하면 폴더 안의 마크다운이 타입이 붙은 데이터가 된다.
frontmatter가 스키마와 다르면 빌드가 실패한다.

```ts
const til = defineCollection({
	loader: glob({ base: './src/content/til', pattern: '**/*.{md,mdx}' }),
	schema: z.object({
		title: z.string(),
		pubDate: z.coerce.date(),
	}),
});
```

import { getCollection } from 'astro:content';

const byDate = (a: { pubDate: Date }, b: { pubDate: Date }) =>
	b.pubDate.valueOf() - a.pubDate.valueOf();

export const getBlog = async () =>
	(await getCollection('blog')).map((p) => ({ ...p.data, href: `/blog/${p.id}/` })).sort(byDate);

export const getTil = async () =>
	(await getCollection('til')).map((p) => ({ ...p.data, href: `/til/${p.id}/` })).sort(byDate);

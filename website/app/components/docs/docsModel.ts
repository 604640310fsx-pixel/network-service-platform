export type DocumentationSection = {
  readonly heading?: string;
  readonly paragraphs?: readonly string[];
  readonly steps?: readonly string[];
};

export type DocumentationArticle = {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly summary: string;
  /** Plain text only. The module never accepts or injects HTML. */
  readonly sections: readonly DocumentationSection[];
};

function searchableArticleText(article: DocumentationArticle): string {
  const sectionText = article.sections.flatMap((section) => [
    section.heading ?? "",
    ...(section.paragraphs ?? []),
    ...(section.steps ?? []),
  ]);
  return [article.title, article.summary, article.category, ...sectionText]
    .join("\n")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN");
}

export function documentCategories(articles: readonly DocumentationArticle[]): readonly string[] {
  return [...new Set(articles.map((article) => article.category))];
}

export function filterDocumentationArticles(
  articles: readonly DocumentationArticle[],
  query: string,
  category: string | null,
): readonly DocumentationArticle[] {
  const normalizedQuery = query.trim().normalize("NFKC").toLocaleLowerCase("zh-CN");
  return articles.filter((article) => {
    if (category !== null && article.category !== category) return false;
    return normalizedQuery === "" || searchableArticleText(article).includes(normalizedQuery);
  });
}

import { useId, useRef, useState } from "react";
import {
  documentCategories,
  filterDocumentationArticles,
  type DocumentationArticle,
} from "./docsModel";
import "./docs.css";

export type DocsLibraryProps = {
  /** Only repository-approved or Packet-approved article bodies may be supplied. */
  readonly articles?: readonly DocumentationArticle[];
  readonly initialArticleId?: string;
};

export function DocsLibrary({ articles = [], initialArticleId }: DocsLibraryProps) {
  const instanceId = useId();
  const readerRef = useRef<HTMLElement>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialArticleId ?? null);

  const categories = documentCategories(articles);
  const visibleArticles = filterDocumentationArticles(articles, query, category);
  const selectedArticle =
    visibleArticles.find((article) => article.id === selectedId) ?? visibleArticles[0] ?? null;

  function selectArticle(article: DocumentationArticle) {
    setSelectedId(article.id);
    requestAnimationFrame(() => readerRef.current?.focus());
  }

  return (
    <main className="cc-docs-page">
      <div className="cc-docs-layout">
        <section className="cc-docs-panel cc-docs-browser" aria-label="使用文档目录">
          <header className="cc-docs-heading">
            <span>DOCUMENTATION</span>
            <h2>使用文档</h2>
            <p>查找订阅地址与常见客户端的导入步骤。</p>
          </header>

          <label className="cc-docs-search" htmlFor={`${instanceId}-search`}>
            <span>搜索文档</span>
            <input
              id={`${instanceId}-search`}
              type="search"
              value={query}
              placeholder="搜索标题、分类或正文"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>

          {categories.length > 0 && (
            <div className="cc-docs-categories" aria-label="文档分类">
              <button
                type="button"
                className={category === null ? "is-active" : undefined}
                aria-pressed={category === null}
                onClick={() => setCategory(null)}
              >
                全部
              </button>
              {categories.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={category === item ? "is-active" : undefined}
                  aria-pressed={category === item}
                  onClick={() => setCategory(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          )}

          {articles.length === 0 ? (
            <div className="cc-docs-notice" role="status">
              <strong>使用文档待接入</strong>
              <p>当前没有可展示的已批准正文，本页不会生成或补写教程。</p>
            </div>
          ) : visibleArticles.length === 0 ? (
            <div className="cc-docs-notice" role="status">
              <strong>没有匹配的文档</strong>
              <p>请调整关键词或分类。</p>
            </div>
          ) : (
            <ul className="cc-docs-list">
              {visibleArticles.map((article) => (
                <li key={article.id}>
                  <button
                    type="button"
                    className={selectedArticle?.id === article.id ? "is-active" : undefined}
                    aria-current={selectedArticle?.id === article.id ? "page" : undefined}
                    onClick={() => selectArticle(article)}
                  >
                    <span>{article.category}</span>
                    <strong>{article.title}</strong>
                    <span className="cc-docs-list-summary">{article.summary}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="cc-docs-panel cc-docs-reader-panel" aria-label="文档正文">
          {selectedArticle === null ? (
            <div className="cc-docs-reader-empty" role="status">
              <span>ARTICLE</span>
              <h2>选择一篇已批准文档阅读</h2>
              <p>正文接入前保持空状态，不使用演示教程替代。</p>
            </div>
          ) : (
            <article className="cc-docs-article" ref={readerRef} tabIndex={-1}>
              <header>
                <span>{selectedArticle.category}</span>
                <h1>{selectedArticle.title}</h1>
                <p>{selectedArticle.summary}</p>
              </header>
              {selectedArticle.sections.map((section, index) => (
                <section key={`${selectedArticle.id}-${index}`}>
                  {section.heading !== undefined && <h2>{section.heading}</h2>}
                  {(section.paragraphs ?? []).map((paragraph, paragraphIndex) => (
                    <p key={`${selectedArticle.id}-${index}-p-${paragraphIndex}`}>{paragraph}</p>
                  ))}
                  {(section.steps?.length ?? 0) > 0 && (
                    <ol>
                      {section.steps?.map((step, stepIndex) => (
                        <li key={`${selectedArticle.id}-${index}-s-${stepIndex}`}>{step}</li>
                      ))}
                    </ol>
                  )}
                  {(section.images ?? []).map((item) => (
                    <figure key={item.src} className="cc-docs-figure">
                      <img src={item.src} alt={item.alt} loading="lazy" decoding="async" />
                      <figcaption>{item.caption}</figcaption>
                    </figure>
                  ))}
                  {section.video !== undefined && (
                    <div className="cc-docs-video">
                      <iframe
                        src={`https://www.youtube-nocookie.com/embed/${section.video.youtubeId}`}
                        title={section.video.title}
                        loading="lazy"
                        referrerPolicy="strict-origin-when-cross-origin"
                        allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; web-share"
                        allowFullScreen
                      />
                      <a
                        href={`https://www.youtube.com/watch?v=${section.video.youtubeId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        在 YouTube 观看
                      </a>
                    </div>
                  )}
                </section>
              ))}
            </article>
          )}
        </section>
      </div>
    </main>
  );
}

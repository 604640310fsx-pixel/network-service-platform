import { useId, useRef, useState, type ReactNode } from "react";
import type { AdvancedNote } from "./advancedDocsContent";
import {
  documentCategories,
  filterDocumentationArticles,
  type DocumentationArticle,
} from "./docsModel";
import "./docs.css";

function noteLinkTarget(value: string): string | null {
  if (/^https?:\/\/[^\s]+$/i.test(value)) return value;
  if (/^[\w.-]+\.[a-z]{2,}(?:\/[^\s]*)?$/i.test(value)) return `https://${value}`;
  return null;
}

function noteInline(value: string): ReactNode[] {
  return value
    .split(/(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|~~[^~]+~~)/g)
    .filter(Boolean)
    .map((part, index) => {
      const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) {
        const href = noteLinkTarget(link[2]);
        return href ? (
          <a key={index} href={href} target="_blank" rel="noopener noreferrer">
            {link[1]}
          </a>
        ) : (
          <span key={index}>{link[1]}</span>
        );
      }
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={index}>{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith("~~") && part.endsWith("~~")) {
        return <del key={index}>{part.slice(2, -2)}</del>;
      }
      return <span key={index}>{part.replaceAll("**", "")}</span>;
    });
}

function noteText(text: string, title: string, firstPart: boolean): ReactNode[] {
  const lines = text.split("\n");
  return lines.map((line, index) => {
    const trimmed = line.trim();
    const plain = trimmed.replaceAll("**", "");
    if (firstPart && index === 0 && plain === title) return null;
    if (trimmed === "" || trimmed === "****" || trimmed === "**") {
      return <span className="cc-docs-note-gap" key={index} aria-hidden="true" />;
    }
    if (/^\s*\*\s+/.test(line)) {
      return <p className="cc-docs-note-bullet" key={index}>• {noteInline(line.replace(/^\s*\*\s+/, ""))}</p>;
    }
    if (
      (trimmed.startsWith("**") || (firstPart && index === 1 && trimmed.endsWith("**"))) &&
      plain.length < 85 &&
      !plain.includes("。")
    ) {
      return <h2 key={index}>{noteInline(trimmed)}</h2>;
    }
    return <p key={index}>{noteInline(line)}</p>;
  });
}

function AdvancedNoteBody({ note }: { readonly note: AdvancedNote }) {
  const parts = note.body.split(/(\[attachment:[^\]]+\]|\uFFFC)/g);
  let slotIndex = 0;
  return (
    <div className="cc-docs-note-body">
      {parts.map((part, partIndex) => {
        if (part.startsWith("[attachment:") || part === "\uFFFC") {
          const slot = note.imageSlots[slotIndex] ?? [];
          slotIndex += 1;
          return slot.map((src, imageIndex) => (
            <figure key={`${partIndex}-${imageIndex}`} className="cc-docs-figure">
              <img src={src} alt={`${note.title}：原文图片 ${slotIndex}`} loading="lazy" decoding="async" />
            </figure>
          ));
        }
        return <div key={partIndex}>{noteText(part, note.title, partIndex === 0)}</div>;
      })}
    </div>
  );
}

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
    requestAnimationFrame(() => readerRef.current?.focus({ preventScroll: true }));
  }

  return (
    <main className="cc-docs-page">
      <div className="cc-docs-layout">
        <section className="cc-docs-panel cc-docs-browser" aria-label="使用文档目录">
          <header className="cc-docs-heading">
            <span>DOCUMENTATION</span>
            <h2>使用文档</h2>
            <p>查找订阅导入、代理工具下载与进阶教程。</p>
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
                  {(section.links?.length ?? 0) > 0 && (
                    <ul className="cc-docs-download-list">
                      {section.links?.map((item) => (
                        <li key={item.url}>
                          <span>{item.label}</span>
                          <a href={item.url} target="_blank" rel="noopener noreferrer">
                            前往下载 ↗
                          </a>
                        </li>
                      ))}
                    </ul>
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
              {selectedArticle.note !== undefined && <AdvancedNoteBody note={selectedArticle.note} />}
            </article>
          )}
        </section>
      </div>
    </main>
  );
}

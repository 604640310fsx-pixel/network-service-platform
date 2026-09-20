import { useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { AdvancedNote } from "./advancedDocsContent";
import {
  documentCategories,
  filterDocumentationArticles,
  type DocumentationArticle,
  type DocumentationImage,
} from "./docsModel";
import "./docs.css";

function noteLinkTarget(value: string): string | null {
  if (value === "/diagnosis") return value;
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
        if (href === "/diagnosis") return <Link key={index} to={href}>{link[1]}</Link>;
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
              <img src={src} alt={`${note.title}：配图 ${slotIndex}`} loading="lazy" decoding="async" />
            </figure>
          ));
        }
        return <div key={partIndex}>{noteText(part, note.title, partIndex === 0)}</div>;
      })}
    </div>
  );
}

function docsImage(image: DocumentationImage, key: string) {
  return (
    <figure key={key} className="cc-docs-figure">
      <a href={image.src} target="_blank" rel="noopener noreferrer" aria-label={`查看大图：${image.alt}`}>
        <img src={image.src} alt={image.alt} loading="lazy" decoding="async" />
      </a>
      <figcaption>{image.caption}<span className="cc-docs-image-hint">点按图片查看大图</span></figcaption>
    </figure>
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
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [searchCollapsedGroups, setSearchCollapsedGroups] = useState<Record<string, boolean>>({});
  const [selectedId, setSelectedId] = useState<string | null>(initialArticleId ?? null);

  const downloadArticle = articles.find((article) => article.id === "proxy-tool-downloads");
  const visibleArticles = filterDocumentationArticles(articles, query, null);
  const directoryArticles = visibleArticles.filter((article) => article.id !== downloadArticle?.id);
  const groups = documentCategories(directoryArticles).map((name) => ({
    name,
    articles: directoryArticles.filter((article) => article.category === name),
  }));
  const searching = query.trim().length > 0;
  const selectedArticle =
    visibleArticles.find((article) => article.id === selectedId) ??
    (selectedId === null && !searching ? visibleArticles.find((article) => article.id === "home-ip-quality") : undefined) ??
    visibleArticles[0] ?? null;

  function selectArticle(article: DocumentationArticle) {
    setSelectedId(article.id);
    requestAnimationFrame(() => {
      const reader = readerRef.current;
      if (reader === null) return;
      if (!window.matchMedia("(max-width: 980px)").matches) return;
      reader.focus({ preventScroll: true });

      const topbarHeight = document.querySelector<HTMLElement>(".cc-topbar")?.getBoundingClientRect().height ?? 0;
      const top = window.scrollY + reader.getBoundingClientRect().top - topbarHeight - 12;
      window.scrollTo({
        top: Math.max(0, top),
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    });
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

          {downloadArticle !== undefined && (
            <button
              type="button"
              className={`cc-docs-download-entry${selectedArticle?.id === downloadArticle.id ? " is-active" : ""}`}
              aria-current={selectedArticle?.id === downloadArticle.id ? "page" : undefined}
              onClick={() => {
                setQuery("");
                setExpandedGroups({});
                setSearchCollapsedGroups({});
                selectArticle(downloadArticle);
              }}
            >
              <strong>代理工具下载 →</strong>
              <span>在本站按设备系统查找客户端下载链接</span>
            </button>
          )}

          <label className="cc-docs-search" htmlFor={`${instanceId}-search`}>
            <span>搜索文档</span>
            <input
              id={`${instanceId}-search`}
              type="search"
              value={query}
              placeholder="搜索标题、分类或正文"
              onChange={(event) => {
                const nextQuery = event.currentTarget.value;
                setQuery(nextQuery);
                if (nextQuery.trim().length === 0) setExpandedGroups({});
                setSearchCollapsedGroups({});
              }}
            />
          </label>

          {articles.length === 0 ? (
            <div className="cc-docs-notice" role="status">
              <strong>使用文档待接入</strong>
              <p>当前没有可展示的已批准正文，本页不会生成或补写教程。</p>
            </div>
          ) : visibleArticles.length === 0 ? (
            <div className="cc-docs-notice" role="status">
              <strong>没有匹配的文档</strong>
              <p>请调整搜索关键词。</p>
            </div>
          ) : groups.length > 0 ? (
            <div className="cc-docs-groups">
              {groups.map((group, groupIndex) => {
                const expanded = searching
                  ? searchCollapsedGroups[group.name] !== true
                  : expandedGroups[group.name] === true;
                const groupId = `${instanceId}-group-${groupIndex}`;
                return (
                  <section key={group.name} className="cc-docs-group">
                    <button
                      type="button"
                      className="cc-docs-group-heading"
                      aria-expanded={expanded}
                      aria-controls={groupId}
                      onClick={() => {
                        if (searching) {
                          setSearchCollapsedGroups((current) => ({ ...current, [group.name]: !current[group.name] }));
                        } else {
                          setExpandedGroups((current) => ({ ...current, [group.name]: !expanded }));
                        }
                      }}
                    >
                      <span>{group.name}（{group.articles.length}）</span>
                      <span className="cc-docs-group-action">
                        <span>{expanded ? "点击收起" : "点击展开"}</span>
                        <span className={`cc-docs-group-arrow${expanded ? " is-expanded" : ""}`} aria-hidden="true">▾</span>
                      </span>
                    </button>
                    <ul id={groupId} className="cc-docs-list" hidden={!expanded}>
                      {group.articles.map((article) => (
                        <li key={article.id}>
                          <button
                            type="button"
                            className={selectedArticle?.id === article.id ? "is-active" : undefined}
                            aria-current={selectedArticle?.id === article.id ? "page" : undefined}
                            onClick={() => selectArticle(article)}
                          >
                            <strong>{article.title}</strong>
                            <span className="cc-docs-list-summary">{article.summary}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          ) : null}
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
                  {(section.paragraphs ?? []).map((paragraph, paragraphIndex) =>
                    typeof paragraph === "string" ? (
                      <p key={`${selectedArticle.id}-${index}-p-${paragraphIndex}`}>{paragraph}</p>
                    ) : (
                      <div key={`${selectedArticle.id}-${index}-p-${paragraphIndex}`}>
                        <p>{paragraph.text}</p>
                        {paragraph.images.map((image, imageIndex) =>
                          docsImage(image, `${selectedArticle.id}-${index}-p-${paragraphIndex}-${imageIndex}`)
                        )}
                      </div>
                    ),
                  )}
                  {(section.steps?.length ?? 0) > 0 && (
                    <ol>
                      {section.steps?.map((step, stepIndex) => (
                        <li key={`${selectedArticle.id}-${index}-s-${stepIndex}`}>
                          {typeof step === "string" ? step : step.text}
                          {typeof step !== "string" && step.images.map((image, imageIndex) =>
                            docsImage(image, `${selectedArticle.id}-${index}-s-${stepIndex}-${imageIndex}`)
                          )}
                        </li>
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
                  {(section.images ?? []).map((item, imageIndex) =>
                    docsImage(item, `${selectedArticle.id}-${index}-image-${imageIndex}`)
                  )}
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

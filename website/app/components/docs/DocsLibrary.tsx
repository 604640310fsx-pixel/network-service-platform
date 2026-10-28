import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useI18n, useT, type Messages } from "../../lib/i18n";
import type { AdvancedNote } from "./advancedDocsContent";
import {
  documentGroups,
  filterDocumentationArticles,
  localizeDocumentationArticles,
  noteLineKind,
  structuredLineKind,
  type DocumentationArticle,
  type DocumentationImage,
} from "./docsModel";
import "./docs.css";

type DocsCopy = Messages["docs"];

function noteLinkTarget(value: string): string | null {
  if (value === "/diagnosis") return value;
  if (/^https?:\/\/[^\s]+$/i.test(value)) return value;
  if (/^[\w.-]+\.[a-z]{2,}(?:\/[^\s]*)?$/i.test(value)) return `https://${value}`;
  return null;
}

function noteInline(value: string, onSelectRelatedArticle?: (articleId: string) => void, linksAsText = false): ReactNode[] {
  return value
    .split(/(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|~~[^~]+~~)/g)
    .filter(Boolean)
    .map((part, index) => {
      const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) {
        if (linksAsText) return <span key={index}>{link[1]}</span>;
        const relatedId = link[2].startsWith("article:") ? link[2].slice("article:".length) : null;
        if (
          onSelectRelatedArticle !== undefined &&
          (relatedId === "home-ip-quality" || relatedId === "proxy-detection-risk")
        ) {
          return <button key={index} type="button" className="cc-docs-note-link" onClick={() => onSelectRelatedArticle(relatedId)}>{link[1]}</button>;
        }
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

function noteText(text: string, title: string, firstPart: boolean, onSelectRelatedArticle?: (articleId: string) => void): ReactNode[] {
  const lines = text.split("\n");
  return lines.map((line, index) => {
    switch (noteLineKind(line, index, firstPart, title)) {
      case "hidden":
        return null;
      case "gap":
        return <span className="cc-docs-note-gap" key={index} aria-hidden="true" />;
      case "bullet":
        return <p className="cc-docs-note-bullet" key={index}>• {noteInline(line.replace(/^\s*\*\s+/, ""), onSelectRelatedArticle)}</p>;
      case "heading":
        return <h2 key={index}>{noteInline(line.trim(), onSelectRelatedArticle)}</h2>;
      default:
        return <p key={index}>{noteInline(line, onSelectRelatedArticle)}</p>;
    }
  });
}

function structuredNoteText(body: string): ReactNode[] {
  return body.split("\n").map((line, index) => {
    const text = line.trimStart();
    switch (structuredLineKind(line)) {
      case "gap":
        return <span className="cc-docs-note-gap" key={index} aria-hidden="true" />;
      case "section":
        return <h2 key={index}>{noteInline(text, undefined, true)}</h2>;
      case "subsection":
        return <h3 key={index}>{noteInline(text, undefined, true)}</h3>;
      case "bullet":
      case "nested-bullet":
        return <p className={`cc-docs-structured-bullet${line.startsWith("  ") ? " is-nested" : ""}`} key={index}>{noteInline(text, undefined, true)}</p>;
      default:
        return <p key={index}>{noteInline(text, undefined, true)}</p>;
    }
  });
}

function AdvancedNoteBody({ note, copy, onSelectRelatedArticle }: {
  readonly note: AdvancedNote;
  readonly copy: DocsCopy;
  readonly onSelectRelatedArticle?: (articleId: string) => void;
}) {
  if (note.structured) return <div className="cc-docs-note-body cc-docs-structured-note">{structuredNoteText(note.body)}</div>;
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
              <img src={src} alt={copy.figureAlt(note.title, slotIndex)} loading="lazy" decoding="async" />
            </figure>
          ));
        }
        return <div key={partIndex}>{noteText(part, note.title, partIndex === 0, onSelectRelatedArticle)}</div>;
      })}
    </div>
  );
}

function docsImage(image: DocumentationImage, key: string, copy: DocsCopy) {
  return (
    <figure key={key} className="cc-docs-figure">
      <a href={image.src} target="_blank" rel="noopener noreferrer" aria-label={copy.openImage(image.alt)}>
        <img src={image.src} alt={image.alt} loading="lazy" decoding="async" />
      </a>
      <figcaption>{image.caption}<span className="cc-docs-image-hint">{copy.imageHint}</span></figcaption>
    </figure>
  );
}

export type DocsLibraryProps = {
  /** Only repository-approved or Packet-approved article bodies may be supplied. */
  readonly articles?: readonly DocumentationArticle[];
  readonly initialArticleId?: string;
};

export function DocsLibrary({ articles: sourceArticles = [], initialArticleId }: DocsLibraryProps) {
  const { lang } = useI18n();
  const copy = useT().docs;
  // Switching language swaps the reader text in place; ids, selection and group keys stay stable.
  const articles = useMemo(() => localizeDocumentationArticles(sourceArticles, lang), [sourceArticles, lang]);
  const instanceId = useId();
  const readerRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [searchCollapsedGroups, setSearchCollapsedGroups] = useState<Record<string, boolean>>({});
  const [selectedId, setSelectedId] = useState<string | null>(initialArticleId ?? null);

  const downloadArticle = articles.find((article) => article.id === "proxy-tool-downloads");
  const visibleArticles = filterDocumentationArticles(articles, query, null);
  const directoryArticles = visibleArticles.filter((article) => article.id !== downloadArticle?.id);
  const groups = documentGroups(directoryArticles);
  const searching = query.trim().length > 0;
  const selectedArticle =
    visibleArticles.find((article) => article.id === selectedId) ??
    (selectedId === null && !searching ? visibleArticles.find((article) => article.id === "home-ip-quality") : undefined) ??
    visibleArticles[0] ?? null;

  function updateQuery(nextQuery: string) {
    setQuery(nextQuery);
    if (nextQuery.trim().length === 0) setExpandedGroups({});
    setSearchCollapsedGroups({});
  }

  function selectArticle(article: DocumentationArticle) {
    setSelectedId(article.id);
    requestAnimationFrame(() => {
      const reader = readerRef.current;
      if (reader === null) return;
      const stacked = window.matchMedia("(max-width: 980px)").matches;
      reader.focus({ preventScroll: true });

      const topbarHeight = document.querySelector<HTMLElement>(".cc-topbar")?.getBoundingClientRect().height ?? 0;
      const top = window.scrollY + reader.getBoundingClientRect().top - topbarHeight - 12;
      window.scrollTo({
        top: Math.max(0, top),
        behavior: !stacked || window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    });
  }

  function selectRelatedArticle(articleId: string) {
    const article = articles.find((item) => item.id === articleId);
    if (article === undefined) return;
    if (query.trim()) {
      setQuery("");
      setSearchCollapsedGroups({});
    }
    selectArticle(article);
  }

  return (
    <main className="cc-docs-page">
      <div className="cc-docs-layout">
        <section className="cc-docs-panel cc-docs-browser" aria-label={copy.directoryLabel}>
          <header className="cc-docs-heading">
            <span>DOCUMENTATION</span>
            <h2>{copy.title}</h2>
            <p>{copy.lead}</p>
          </header>

          {downloadArticle !== undefined && (
            <button
              type="button"
              className={`cc-docs-download-entry${selectedArticle?.id === downloadArticle.id ? " is-active" : ""}`}
              aria-current={selectedArticle?.id === downloadArticle.id ? "page" : undefined}
              onClick={() => {
                setQuery("");
                setSearchCollapsedGroups({});
                selectArticle(downloadArticle);
              }}
            >
              <strong>{copy.downloadTitle}</strong>
              <span>{copy.downloadHint}</span>
            </button>
          )}

          <label className="cc-docs-search" htmlFor={`${instanceId}-search`}>
            <span>{copy.searchLabel}</span>
            <input
              ref={searchRef}
              id={`${instanceId}-search`}
              type="search"
              value={query}
              placeholder={copy.searchPlaceholder}
              onChange={(event) => updateQuery(event.currentTarget.value)}
            />
          </label>

          {articles.length === 0 ? (
            <div className="cc-docs-notice" role="status">
              <strong>{copy.emptyTitle}</strong>
              <p>{copy.emptyBody}</p>
            </div>
          ) : visibleArticles.length === 0 ? (
            <div className="cc-docs-notice" role="status">
              <strong>{copy.noMatchTitle}</strong>
              <p>{copy.noMatchBody}</p>
              <button
                type="button"
                className="cc-docs-download-entry"
                onClick={() => {
                  updateQuery("");
                  searchRef.current?.focus();
                }}
              >
                <strong>{copy.clearSearch}</strong>
              </button>
            </div>
          ) : groups.length > 0 ? (
            <div className="cc-docs-groups">
              {groups.map((group, groupIndex) => {
                const expanded = searching
                  ? searchCollapsedGroups[group.key] !== true
                  : expandedGroups[group.key] === true;
                const groupId = `${instanceId}-group-${groupIndex}`;
                return (
                  <section key={group.key} className="cc-docs-group">
                    <button
                      type="button"
                      className="cc-docs-group-heading"
                      aria-expanded={expanded}
                      aria-controls={groupId}
                      onClick={() => {
                        if (searching) {
                          setSearchCollapsedGroups((current) => ({ ...current, [group.key]: !current[group.key] }));
                        } else {
                          setExpandedGroups((current) => ({ ...current, [group.key]: !expanded }));
                        }
                      }}
                    >
                      <span>{copy.groupHeading(group.name, group.articles.length)}</span>
                      <span className="cc-docs-group-action">
                        <span>{expanded ? copy.collapse : copy.expand}</span>
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

        <section className="cc-docs-panel cc-docs-reader-panel" aria-label={copy.readerLabel}>
          {selectedArticle === null ? (
            <div className="cc-docs-reader-empty" role="status">
              <span>ARTICLE</span>
              <h2>{copy.readerEmptyTitle}</h2>
              <p>{copy.readerEmptyBody}</p>
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
                          docsImage(image, `${selectedArticle.id}-${index}-p-${paragraphIndex}-${imageIndex}`, copy)
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
                            docsImage(image, `${selectedArticle.id}-${index}-s-${stepIndex}-${imageIndex}`, copy)
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
                            {copy.download}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                  {(section.images ?? []).map((item, imageIndex) =>
                    docsImage(item, `${selectedArticle.id}-${index}-image-${imageIndex}`, copy)
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
                        {copy.watchOnYoutube}
                      </a>
                    </div>
                  )}
                </section>
              ))}
              {selectedArticle.note?.editorNote !== undefined && (
                <aside className="cc-docs-editor-note" aria-label={copy.editorNote}>
                  <strong>{copy.editorNote}</strong>
                  <p>{selectedArticle.note.editorNote}</p>
                </aside>
              )}
              {selectedArticle.note !== undefined && (
                <AdvancedNoteBody
                  note={selectedArticle.note}
                  copy={copy}
                  onSelectRelatedArticle={selectedArticle.id === "claude-gpt-account-advice" ? selectRelatedArticle : undefined}
                />
              )}
            </article>
          )}
        </section>
      </div>
    </main>
  );
}

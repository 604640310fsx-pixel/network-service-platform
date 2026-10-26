import test from "node:test";
import assert from "node:assert/strict";
import {
  SUBSCRIPTION_IMPORT_ARTICLES,
  documentGroups,
  filterDocumentationArticles,
  localizeDocumentationArticles,
  noteLineKind,
  structuredLineKind,
  type DocumentationArticle,
  type DocumentationSection,
  type DocumentationText,
} from "../app/components/docs/docsModel.ts";
import { en } from "../app/i18n/en.ts";
import { zh } from "../app/i18n/zh.ts";

const ZH = SUBSCRIPTION_IMPORT_ARTICLES;
const EN = localizeDocumentationArticles(ZH, "en");
const CJK = /[㐀-鿿]/;
const PLACEHOLDER = /\[attachment:[^\]]+\]|￼/g;

function byId(list: readonly DocumentationArticle[], id: string): DocumentationArticle {
  const article = list.find((item) => item.id === id);
  assert.ok(article, `missing ${id}`);
  return article;
}

/** Chinese UI labels are kept in parentheses next to the English label, e.g. “Profiles” (配置). */
function withoutParenthesisedLabels(text: string): string {
  return text.replace(/[（(][^()（）]*[㐀-鿿][^()（）]*[)）]/g, "");
}

function textOf(item: DocumentationText): string {
  return typeof item === "string" ? item : item.text;
}

function sectionShape(section: DocumentationSection) {
  const kinds = (items?: readonly DocumentationText[]) =>
    (items ?? []).map((item) => (typeof item === "string" ? "text" : item.images.map((image) => image.src).join("+")));
  return {
    heading: section.heading !== undefined,
    paragraphs: kinds(section.paragraphs),
    steps: kinds(section.steps),
    links: (section.links ?? []).map((link) => link.url),
    images: (section.images ?? []).map((image) => image.src),
    video: section.video?.youtubeId ?? null,
  };
}

function sectionTexts(section: DocumentationSection): string[] {
  const images = (items?: readonly DocumentationText[]) =>
    (items ?? []).flatMap((item) => (typeof item === "string" ? [] : item.images.flatMap((image) => [image.alt, image.caption])));
  return [
    section.heading ?? "",
    ...(section.paragraphs ?? []).map(textOf),
    ...(section.steps ?? []).map(textOf),
    ...images(section.paragraphs),
    ...images(section.steps),
    ...(section.links ?? []).map((link) => link.label),
    section.video?.title ?? "",
  ];
}

test("Chinese stays the default view and is returned unchanged", () => {
  assert.equal(localizeDocumentationArticles(ZH, "zh"), ZH);
  assert.equal(byId(ZH, "flclash-import").title, "FlClash：通过 URL 导入订阅");
});

test("every article has complete English text without leftover Chinese", () => {
  assert.deepEqual(EN.map((item) => item.id), ZH.map((item) => item.id));
  for (const article of ZH) {
    assert.ok(article.en, `${article.id} has no en text`);
    const localized = byId(EN, article.id);
    for (const value of [localized.title, localized.summary, localized.category]) {
      assert.ok(value.trim(), `${article.id} has an empty field`);
      assert.doesNotMatch(value, CJK, `${article.id}: ${value}`);
    }
    if (article.note) {
      assert.ok(article.note.en.title && article.note.en.summary && article.note.en.body);
      assert.equal(localized.title, article.note.en.title);
      assert.equal(localized.note?.body, article.note.en.body);
      // Only the deliberate Chinese date-format example may stay in Chinese.
      assert.doesNotMatch(localized.note.body.replaceAll("2025年1月20日", ""), CJK, article.id);
    }
    for (const section of localized.sections) {
      for (const text of sectionTexts(section)) {
        assert.doesNotMatch(withoutParenthesisedLabels(text), CJK, `${article.id}: ${text}`);
      }
    }
  }
});

test("English guides mirror the Chinese section structure, images, links and video", () => {
  for (const article of ZH.filter((item) => item.note === undefined)) {
    const localized = byId(EN, article.id);
    assert.deepEqual(localized.sections.map(sectionShape), article.sections.map(sectionShape), article.id);
    for (const section of localized.sections) {
      for (const item of [...(section.paragraphs ?? []), ...(section.steps ?? [])]) {
        if (typeof item !== "string") {
          for (const image of item.images) assert.ok(image.alt && image.caption, `${article.id}: ${image.src}`);
        }
      }
    }
  }
});

test("English note bodies keep image placeholders in the same count, kind and order", () => {
  for (const article of ZH.filter((item) => item.note !== undefined)) {
    const zhNote = article.note!;
    const enNote = byId(EN, article.id).note!;
    const kinds = (body: string) => [...body.matchAll(PLACEHOLDER)].map((match) => (match[0] === "￼" ? "obj" : "attachment"));
    assert.deepEqual(kinds(enNote.body), kinds(zhNote.body), article.id);
    assert.equal(kinds(enNote.body).length, zhNote.imageSlots.length, article.id);
    assert.equal(enNote.imageSlots, zhNote.imageSlots, "images are shared, not copied");
    assert.equal(enNote.body.split("\n").length, zhNote.body.split("\n").length, `${article.id} line count`);
  }
});

test("English notes render with the same line structure as the Chinese notes", () => {
  // The Chinese 「原理」 line under browser language is a sentence that happens to render as a
  // heading; its English translation is a full sentence and renders as a paragraph.
  const allowed = new Set(["proxy-detection-risk:114"]);
  const kinds = (body: string, title: string) =>
    body.split(/(\[attachment:[^\]]+\]|￼)/g).flatMap((part, partIndex) =>
      part.startsWith("[attachment:") || part === "￼"
        ? ["image"]
        : part.split("\n").map((line, index) => noteLineKind(line, index, partIndex === 0, title)),
    );
  for (const article of ZH.filter((item) => item.note !== undefined && !item.note.structured)) {
    const zhKinds = kinds(article.note!.body, article.note!.title);
    const localized = byId(EN, article.id).note!;
    const enKinds = kinds(localized.body, localized.title);
    assert.equal(enKinds.length, zhKinds.length, article.id);
    zhKinds.forEach((kind, index) => {
      if (allowed.has(`${article.id}:${index}`)) return;
      assert.equal(enKinds[index], kind, `${article.id} line ${index}`);
    });
  }
  const structured = byId(ZH, "tk-fb-environment-guide").note!;
  const structuredEn = byId(EN, "tk-fb-environment-guide").note!;
  assert.deepEqual(structuredEn.body.split("\n").map(structuredLineKind), structured.body.split("\n").map(structuredLineKind));
  assert.equal(structuredEn.body.split("\n").filter((line) => structuredLineKind(line) === "section").length, 7);
});

test("heading detection keeps the Chinese behaviour and handles English prose", () => {
  assert.equal(noteLineKind("**IPQS查看滥用情况**", 3, false, ""), "heading");
  assert.equal(noteLineKind("**记住**：风控看的是**一致性**，不是单一指标。", 3, false, ""), "paragraph");
  assert.equal(noteLineKind("**2.2 STUN servers and ICE candidates", 3, false, ""), "heading");
  assert.equal(noteLineKind("**3.3 What causes DNS leaks?", 3, false, ""), "heading");
  assert.equal(noteLineKind("**Remember**: it looks at consistency. One mismatch is fine.", 3, false, ""), "paragraph");
  assert.equal(structuredLineKind("III. Core Shadowrocket leak-prevention settings"), "section");
  assert.equal(structuredLineKind("三、 小火箭"), "section");
  assert.equal(structuredLineKind("1. Global routing mode:"), "subsection");
});

test("article: links in English point to valid articles and match the Chinese targets", () => {
  const ids = new Set(ZH.map((item) => item.id));
  const targets = (body: string) => [...body.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
  for (const article of ZH.filter((item) => item.note !== undefined)) {
    const zhTargets = targets(article.note!.body);
    const enTargets = targets(byId(EN, article.id).note!.body);
    assert.deepEqual(enTargets, zhTargets, article.id);
    for (const target of enTargets.filter((value) => value.startsWith("article:"))) {
      assert.ok(ids.has(target.slice("article:".length)), target);
    }
  }
  assert.match(byId(EN, "claude-gpt-account-advice").note!.body, /\[Residential IP Quality Check Guide\]\(article:home-ip-quality\)/);
});

test("categories are bilingual and grouping keys stay stable across languages", () => {
  const directory = (list: readonly DocumentationArticle[]) => documentGroups(list).map((group) => [group.key, group.name, group.articles.length]);
  assert.deepEqual(directory(ZH), [
    ["subscription-import", "订阅导入", 4],
    ["proxy-tool-downloads", "代理工具下载", 1],
    ["advanced", "进阶教程", 5],
  ]);
  assert.deepEqual(directory(EN), [
    ["subscription-import", "Subscription import", 4],
    ["proxy-tool-downloads", "Proxy tool downloads", 1],
    ["advanced", "Advanced guides", 5],
  ]);
});

test("search only matches the current language", () => {
  const ids = (list: readonly DocumentationArticle[], query: string) => filterDocumentationArticles(list, query, null).map((item) => item.id);
  assert.deepEqual(ids(EN, "Get profile from URL"), ["flclash-import"]);
  assert.deepEqual(ids(ZH, "Get profile from URL"), []);
  assert.deepEqual(ids(EN, "通过 URL 获取配置文件"), []);
  assert.deepEqual(ids(EN, "KYC"), ["claude-gpt-account-advice"]);
  assert.deepEqual(ids(EN, "advanced guides").length, 5);
  assert.deepEqual(ids(EN, "kill switch"), ["tk-fb-environment-guide"]);
  assert.deepEqual(ids(EN, "WebRTC Leak Prevent"), ["proxy-detection-risk"]);
});

test("docs UI copy exists in both dictionaries", () => {
  assert.deepEqual(Object.keys(en.docs).sort(), Object.keys(zh.docs).sort());
  assert.equal(en.docs.clearSearch, "Clear search");
  assert.equal(zh.docs.clearSearch, "清空搜索");
  assert.equal(en.docs.groupHeading("Advanced guides", 5), "Advanced guides (5)");
  assert.equal(zh.docs.groupHeading("进阶教程", 5), "进阶教程（5）");
  for (const [key, value] of Object.entries(en.docs)) {
    if (typeof value === "string") assert.doesNotMatch(value, CJK, key);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { documentCategories, filterDocumentationArticles } from "./docsModel.ts";

// 演示数据 · 非报价；仅用于验证搜索/分类，不是正式教程正文。
const ARTICLES = [
  {
    id: "approved-a",
    category: "开始使用",
    title: "已批准正文 A",
    summary: "演示数据 · 非报价",
    sections: [{ heading: "检查", paragraphs: ["正文关键词 Alpha"] }],
  },
  {
    id: "approved-b",
    category: "常见问题",
    title: "已批准正文 B",
    summary: "演示数据 · 非报价",
    sections: [{ steps: ["正文关键词 Beta"] }],
  },
];

test("categories preserve approved article order and remove duplicates", () => {
  assert.deepEqual(documentCategories([...ARTICLES, { ...ARTICLES[0], id: "approved-c" }]), [
    "开始使用",
    "常见问题",
  ]);
});

test("document search covers title, category, summary and plain-text sections", () => {
  assert.deepEqual(filterDocumentationArticles(ARTICLES, "alpha", null).map((item) => item.id), [
    "approved-a",
  ]);
  assert.deepEqual(filterDocumentationArticles(ARTICLES, "ＢＥＴＡ", null).map((item) => item.id), [
    "approved-b",
  ]);
  assert.deepEqual(filterDocumentationArticles(ARTICLES, "常见问题", null).map((item) => item.id), [
    "approved-b",
  ]);
});

test("category and query filters compose without inventing fallback documents", () => {
  assert.deepEqual(filterDocumentationArticles(ARTICLES, "", "开始使用").map((item) => item.id), [
    "approved-a",
  ]);
  assert.deepEqual(filterDocumentationArticles(ARTICLES, "missing", null), []);
  assert.deepEqual(filterDocumentationArticles([], "", null), []);
});

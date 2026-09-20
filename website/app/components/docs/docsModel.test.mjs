import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import {
  SUBSCRIPTION_IMPORT_ARTICLES,
  documentCategories,
  filterDocumentationArticles,
} from "./docsModel.ts";

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

test("subscription import articles remain searchable by their real reader content", () => {
  assert.deepEqual(documentCategories(SUBSCRIPTION_IMPORT_ARTICLES), [
    "订阅导入",
    "代理工具下载",
    "进阶教程",
  ]);
  assert.deepEqual(
    SUBSCRIPTION_IMPORT_ARTICLES.map((item) => item.id),
    [
      "flclash-import",
      "shadowrocket-import",
      "clash-verge-import",
      "clash-meta-import",
      "proxy-tool-downloads",
      "home-ip-quality",
      "proxy-detection-risk",
      "network-lines-overview",
      "claude-gpt-account-advice",
    ],
  );
  assert.deepEqual(
    filterDocumentationArticles(SUBSCRIPTION_IMPORT_ARTICLES, "通过 URL 获取配置文件", "订阅导入").map(
      (item) => item.id,
    ),
    ["flclash-import"],
  );
  assert.deepEqual(
    filterDocumentationArticles(SUBSCRIPTION_IMPORT_ARTICLES, "Subscribe", "订阅导入").map(
      (item) => item.id,
    ),
    ["shadowrocket-import"],
  );
});

test("download guide keeps the thirteen source links on the local docs page", () => {
  const article = SUBSCRIPTION_IMPORT_ARTICLES.find((item) => item.id === "proxy-tool-downloads");
  assert.ok(article);
  const links = article.sections.flatMap((section) => section.links ?? []);
  assert.equal(links.length, 13);
  assert.ok(links.every((item) => item.url.startsWith("https://99data.qqx.me/")));
  assert.ok(links.some((item) => item.url.endsWith("cmfa-2.11.28-meta-arm64-v8a-release.apk")));
});

test("existing advanced articles retain approved text and original image positions", () => {
  for (const [id, length, slots, occurrences] of [
    ["home-ip-quality", 756, 4, 4],
    ["proxy-detection-risk", 9869, 41, 42],
    ["network-lines-overview", 2604, 0, 0],
  ]) {
    const article = SUBSCRIPTION_IMPORT_ARTICLES.find((item) => item.id === id);
    assert.ok(article?.note);
    assert.equal(article.note.body.length, length);
    assert.equal(article.note.imageSlots.length, slots);
    assert.equal([...article.note.body.matchAll(/\[attachment:[^\]]+\]|\uFFFC/g)].length, slots);
    assert.equal(article.note.imageSlots.flat().length, occurrences);
    for (const src of article.note.imageSlots.flat()) {
      assert.match(src, /^\/docs\/advanced\//);
      assert.ok(existsSync(new URL(`../../../public${src}`, import.meta.url)));
    }
  }
});

test("new personal-advice article joins advanced search without changing existing notes", () => {
  const advanced = SUBSCRIPTION_IMPORT_ARTICLES.filter((item) => item.category === "进阶教程");
  assert.equal(advanced.length, 4);
  const article = advanced.find((item) => item.id === "claude-gpt-account-advice");
  assert.ok(article?.note);
  assert.equal(article.title, "Claude封号与GPT降智的问题");
  assert.equal(article.summary, "个人经验与建议，不代表平台官方规则或效果保证");
  assert.deepEqual(article.note.imageSlots, []);
  assert.match(article.note.body, /\[提交诊断申请\]\(\/diagnosis\)/);
  assert.deepEqual(
    filterDocumentationArticles(SUBSCRIPTION_IMPORT_ARTICLES, "KYC认证", "进阶教程").map((item) => item.id),
    ["claude-gpt-account-advice"],
  );
});

test("proxy article keeps its local guide reference and removes two obsolete external links", () => {
  const body = SUBSCRIPTION_IMPORT_ARTICLES.find((item) => item.id === "proxy-detection-risk")?.note?.body;
  assert.ok(body);
  assert.match(body, /你可以查看家宽IP质量检测指南来看看更深入关于IP的事情。/);
  assert.doesNotMatch(body, /meowvps\.com\/blog\/ipcheck\/|\[家宽\]|\[质量检测指南\]/);
  assert.match(body, /你可以查看\[ipleak\]\(ipleak\.net\/\)和\[browserleaks\]\(browserleaks\.com\/\)的检测结果。/);
  assert.doesNotMatch(body, /我做的小玩具|特征检测工具|meowvps\.com\/tools\/detector\//);
});

test("four client tutorials keep client screenshots at their steps in order", () => {
  const expected = {
    "flclash-import": ["config-entry.jpg", "url-entry.jpg", "url-submit.jpg", "config-entry.jpg", "qr-entry.jpg", "imported-config.png", "start-proxy.png", "autolaunch-entry.jpg", "autolaunch-toggle.jpg", "refresh-config.png"],
    "shadowrocket-import": ["app-store.jpg", "home.png", "subscribe-form.jpg", "settings-entry.jpg", "update-options.jpg", "connected.png", "routing-options.jpg"],
    "clash-verge-import": ["subscription-entry.png", "proxy-list.png", "system-proxy.png"],
    "clash-meta-import": ["home.jpg", "config-entry.jpg", "add-menu.jpg", "url-form.jpg", "file-form.jpg", "start-connection.jpg", "running.jpg", "node-list.jpg", "mode-menu.jpg"],
  };
  for (const [id, names] of Object.entries(expected)) {
    const article = SUBSCRIPTION_IMPORT_ARTICLES.find((item) => item.id === id);
    assert.ok(article, `missing ${id}`);
    assert.ok(article.sections.some((section) => (section.steps?.length ?? 0) >= 2));
    const images = article.sections.flatMap((section) => [
      ...(section.paragraphs ?? []).flatMap((item) => typeof item === "string" ? [] : item.images),
      ...(section.steps ?? []).flatMap((item) => typeof item === "string" ? [] : item.images),
      ...(section.images ?? []),
    ]);
    assert.deepEqual(images.map((image) => image.src.split("/").at(-1)), names);
    for (const image of images) {
      assert.match(image.src, /^\/docs\/subscription-import\//);
      assert.ok(image.alt && image.caption);
      assert.ok(existsSync(new URL(`../../../public${image.src}`, import.meta.url)));
    }
  }
  const shadowrocket = SUBSCRIPTION_IMPORT_ARTICLES.find((item) => item.id === "shadowrocket-import");
  assert.ok(shadowrocket.sections[0].video, "the video should appear before the written steps");
  assert.deepEqual(shadowrocket.sections.find((section) => section.video)?.video, {
    youtubeId: "BKYbtaMdD6A",
    title: "Shadowrocket 客户端视频",
  });
});

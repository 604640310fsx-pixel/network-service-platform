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

// 正文只复用现有订阅导入组件的说明和已批准的客户端展示矩阵。
export const SUBSCRIPTION_IMPORT_ARTICLES: readonly DocumentationArticle[] = [
  {
    id: "subscription-address",
    category: "订阅导入",
    title: "订阅地址、复制与二维码",
    summary: "已开通服务的授权交付数据可用时，查看当前线路的订阅地址。",
    sections: [
      {
        heading: "查看当前线路",
        paragraphs: [
          "在当前套餐或节点与流量页面，打开已开通服务的「查看订阅信息」。只有授权接口返回交付数据后，页面才会显示订阅地址；地址暂不可用时，页面会说明原因。",
          "有多条线路时，先选择线路。地址、复制内容和二维码都对应当前选中的线路。",
        ],
      },
      {
        heading: "复制或显示二维码",
        steps: [
          "使用「复制地址」复制本页当前线路的订阅地址；自动复制失败时，页面会选中地址供手动复制。",
          "使用「显示二维码」查看由当前浏览器本地生成的二维码，不调用第三方二维码服务。",
        ],
      },
      {
        heading: "保护地址",
        paragraphs: [
          "订阅地址属于私密交付信息。只在受信任设备中使用，不要截图、转发或粘贴到第三方网站。",
        ],
      },
    ],
  },
  {
    id: "manual-client-import",
    category: "订阅导入",
    title: "选择客户端并导入",
    summary: "按已批准的设备与客户端清单选择，导入结果以客户端实际显示为准。",
    sections: [
      {
        heading: "手动导入",
        steps: [
          "选择当前设备系统和已安装客户端，复制本页当前线路的订阅地址。",
          "打开所选客户端，进入它的订阅或配置导入入口。",
          "粘贴地址并提交；是否导入成功以客户端实际显示为准。",
        ],
        paragraphs: [
          "页面的客户端清单按已批准矩阵展示；「推荐」是展示标记，不代表兼容性已确认。客户端旁有「导入」时，可点击请求浏览器打开客户端；能否添加由客户端决定。其余客户端请使用手动导入。",
        ],
      },
      {
        heading: "导入不了？",
        paragraphs: [
          "重新复制当前线路地址，避免缺少字符或带入空格；确认所选设备系统与当前客户端一致。浏览器没有唤起客户端时，改用手动导入。",
          "仍无法导入时，只向现有支持渠道提供线路名称、设备系统和客户端名称；不要发送完整订阅地址。",
        ],
      },
    ],
  },
];

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

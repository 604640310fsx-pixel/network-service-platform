export type DocumentationSection = {
  readonly heading?: string;
  readonly paragraphs?: readonly string[];
  readonly steps?: readonly string[];
  readonly images?: readonly {
    readonly src: string;
    readonly alt: string;
    readonly caption: string;
  }[];
  readonly video?: {
    readonly youtubeId: string;
    readonly title: string;
  };
};

export type DocumentationArticle = {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly summary: string;
  /** Plain text only. The module never accepts or injects HTML. */
  readonly sections: readonly DocumentationSection[];
};

// 本站订阅交付说明与获授权复用的四篇客户端教程。图片只引用已检查的本地素材。
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
          "页面的客户端清单按已批准矩阵展示；「推荐」是展示标记，不代表兼容性已确认。客户端旁有「导入」时，可点击请求浏览器打开客户端；能否添加由客户端决定。客户端可能要求特定订阅格式，当前内容格式未核实；未显示入口或导入失败时请使用手动导入。",
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
  {
    id: "flclash-import",
    category: "订阅导入",
    title: "FlClash：通过 URL 导入订阅",
    summary: "在 FlClash 的配置页添加本站当前线路的订阅地址，并查看导入结果。",
    sections: [
      {
        heading: "准备订阅地址",
        paragraphs: [
          "先在本站已开通服务的「查看订阅信息」中选定线路，复制该线路的订阅地址。地址属于私密交付信息，不要发给他人或粘贴到第三方网站。",
          "以下以已安装的 FlClash 为例。客户端界面可能随版本变化，以你实际看到的菜单为准。",
        ],
      },
      {
        heading: "从 URL 添加配置",
        steps: [
          "打开 FlClash，进入「配置」，点击添加按钮（＋）。",
          "在添加配置菜单中选择「URL」或「从 URL 导入」。",
          "粘贴刚复制的订阅地址并提交，等待客户端显示导入结果。",
        ],
        images: [
          {
            src: "/docs/subscription-import/flclash/url-entry.jpg",
            alt: "FlClash 添加配置菜单，URL 导入入口位于右侧",
            caption: "在添加配置菜单中选择 URL。",
          },
          {
            src: "/docs/subscription-import/flclash/url-submit.jpg",
            alt: "FlClash 从 URL 导入对话框，包含 URL 输入框和提交按钮",
            caption: "将本站当前线路的订阅地址粘贴到 URL 输入框。",
          },
        ],
      },
      {
        heading: "检查与更新",
        paragraphs: [
          "导入完成后，确认配置列表出现新配置，再按客户端界面选中它。需要更新时，可在配置页使用刷新入口；是否更新成功以客户端提示为准。",
          "本站二维码编码的是订阅 URL，并非单个节点。FlClash 的二维码入口能否识别该 URL 取决于客户端版本；无法识别时使用上面的 URL 导入。",
        ],
      },
    ],
  },
  {
    id: "shadowrocket-import",
    category: "订阅导入",
    title: "Shadowrocket：添加订阅 URL",
    summary: "在 Shadowrocket 的订阅类型表单中填写本站当前线路的 URL。",
    sections: [
      {
        heading: "准备地址",
        paragraphs: [
          "先在本站已开通服务的「查看订阅信息」中选定线路，复制订阅地址。以下步骤假设设备上已有 Shadowrocket；本站不提供客户端账号或安装服务。",
        ],
      },
      {
        heading: "添加订阅",
        steps: [
          "打开 Shadowrocket，在首页点击添加按钮（＋）。",
          "将类型选为「Subscribe」，在 URL 栏粘贴本站当前线路的订阅地址。备注可自行填写，用于区分线路。",
          "点击完成，回到客户端检查订阅是否出现。若客户端提示格式不支持，以实际提示为准。",
        ],
        images: [
          {
            src: "/docs/subscription-import/shadowrocket/subscribe-form.jpg",
            alt: "Shadowrocket 添加节点表单，类型为 Subscribe，URL 栏待填写",
            caption: "选择 Subscribe 类型，在 URL 栏填写地址。",
          },
        ],
      },
      {
        heading: "按需更新",
        paragraphs: [
          "客户端的「设置」中有「订阅」入口，可按需要选择打开时更新或后台更新。设置项和更新行为随客户端版本而变化。",
        ],
        images: [
          {
            src: "/docs/subscription-import/shadowrocket/settings-entry.jpg",
            alt: "Shadowrocket 设置页面中的订阅入口",
            caption: "设置页的订阅入口。",
          },
          {
            src: "/docs/subscription-import/shadowrocket/update-options.jpg",
            alt: "Shadowrocket 订阅设置中的打开时更新和自动后台更新选项",
            caption: "更新选项可根据自己的需要设置。",
          },
        ],
      },
      {
        heading: "相关视频",
        paragraphs: [
          "原教程提供小火箭相关视频。该视频从 Apple ID 与客户端获取讲起，具体订阅导入片段尚未核实；导入当前线路请以上方图文步骤为准。",
        ],
        video: {
          youtubeId: "BKYbtaMdD6A",
          title: "原教程的小火箭相关视频",
        },
      },
    ],
  },
  {
    id: "clash-verge-import",
    category: "订阅导入",
    title: "Clash Verge：导入并选择配置",
    summary: "在订阅页粘贴当前线路 URL，并在客户端确认导入的配置。",
    sections: [
      {
        heading: "取得当前线路 URL",
        paragraphs: [
          "打开本站已开通服务的「查看订阅信息」，选定线路并复制地址。只使用自己的授权地址，不要把完整 URL 发到聊天、工单或截图中。",
        ],
      },
      {
        heading: "导入订阅",
        steps: [
          "打开已安装的 Clash Verge，进入「订阅」页面。",
          "将地址粘贴到页面顶部的订阅链接输入框，点击客户端显示的「导入」或相应确认按钮。",
          "等待客户端显示配置卡片，并选中刚导入的配置。",
        ],
        paragraphs: ["实际入口以当前客户端版本为准。"],
      },
      {
        heading: "查看代理列表",
        paragraphs: [
          "导入后可进入「代理」查看客户端列出的节点。列表和连接是否可用取决于交付数据及客户端实际结果。若列表为空，先返回订阅页检查导入提示与配置状态。",
          "系统代理、虚拟网卡等网络设置不属于完成订阅导入的必需步骤；如需使用，按设备与客户端自己的说明操作。",
        ],
      },
    ],
  },
  {
    id: "clash-meta-import",
    category: "订阅导入",
    title: "Clash Meta for Android：从 URL 创建配置",
    summary: "在 Android 客户端的配置页选择 URL，并保存本站当前线路的订阅地址。",
    sections: [
      {
        heading: "复制订阅地址",
        paragraphs: [
          "在本站已开通服务的「查看订阅信息」中选定线路并复制地址。以下以已安装的 Clash Meta for Android 为例，不涉及客户端安装。",
        ],
      },
      {
        heading: "从 URL 创建配置",
        steps: [
          "打开客户端，进入「配置」，点击右上角的添加按钮（＋）。",
          "选择「URL／从 URL 导入」，为配置填写便于识别的名称。",
          "在 URL 栏粘贴本站当前线路的订阅地址，保存并等待客户端显示导入结果。",
        ],
        images: [
          {
            src: "/docs/subscription-import/clash-meta/config-entry.jpg",
            alt: "Clash Meta for Android 主界面配置入口和配置页添加按钮",
            caption: "从配置页点击添加按钮。",
          },
          {
            src: "/docs/subscription-import/clash-meta/url-form.jpg",
            alt: "Clash Meta for Android 从 URL 导入入口及名称、URL 表单",
            caption: "选择 URL 导入并填写名称与地址。",
          },
        ],
      },
      {
        heading: "确认配置",
        paragraphs: [
          "返回配置列表确认新配置已出现；如客户端需要，可按界面提示选中该配置。能否成功解析和显示节点，以客户端实际结果为准。",
          "本站二维码编码的是订阅 URL，不保证所有客户端的扫码入口都接受；扫码无效时使用 URL 导入。",
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
    ...(section.images ?? []).flatMap((image) => [image.alt, image.caption]),
    section.video?.title ?? "",
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

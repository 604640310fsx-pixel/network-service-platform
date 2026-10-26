// Node's strip-types test runner needs the extension; Vite resolves the same module during build.
// @ts-ignore TS5097: the website tsconfig does not enable allowImportingTsExtensions.
import { ADVANCED_NOTES, type AdvancedNote } from "./advancedDocsContent.ts";
// @ts-ignore TS5097: see above.
import { SUBSCRIPTION_IMPORT_ARTICLES_EN } from "./docsContentEn.ts";

export type DocsLang = "zh" | "en";

/** Stable grouping key; the displayed category name follows the current language. */
export type DocumentationCategoryId = "subscription-import" | "proxy-tool-downloads" | "advanced";

export type DocumentationImage = {
  readonly src: string;
  readonly alt: string;
  readonly caption: string;
};

export type DocumentationText = string | {
  readonly text: string;
  readonly images: readonly DocumentationImage[];
};

export type DocumentationSection = {
  readonly heading?: string;
  readonly paragraphs?: readonly DocumentationText[];
  readonly steps?: readonly DocumentationText[];
  readonly links?: readonly {
    readonly label: string;
    readonly url: string;
  }[];
  readonly images?: readonly DocumentationImage[];
  readonly video?: {
    readonly youtubeId: string;
    readonly title: string;
  };
};

/** One language's reader text for an article. Sections mirror the Chinese article. */
export type LocalizedArticleText = {
  readonly category: string;
  readonly title: string;
  readonly summary: string;
  readonly sections: readonly DocumentationSection[];
};

export type DocumentationArticle = {
  readonly id: string;
  /** Grouping key; falls back to `category` for articles supplied without one. */
  readonly categoryId?: DocumentationCategoryId;
  readonly category: string;
  readonly title: string;
  readonly summary: string;
  /** Plain text only. The module never accepts or injects HTML. */
  readonly sections: readonly DocumentationSection[];
  readonly note?: AdvancedNote;
  /** English text; the Chinese fields above stay the fallback. */
  readonly en?: LocalizedArticleText;
};

// 获授权的客户端教程、下载说明与环境指南；图片只引用已检查的本地素材。
const ZH_GUIDE_ARTICLES: readonly DocumentationArticle[] = [
  {
    id: "flclash-import",
    category: "订阅导入",
    title: "FlClash：通过 URL 导入订阅",
    summary: "在 FlClash 的配置页添加本站当前线路的订阅地址，并查看导入结果。",
    sections: [
      {
        heading: "准备订阅地址",
        paragraphs: [
          "在「当前套餐」找到已开通服务卡片；有多条线路时先选定线路，再点击「复制地址」。地址属于私密交付信息，不要发给他人或粘贴到第三方网站。",
          "以下以已安装的 FlClash 为例。客户端界面可能随版本变化，以你实际看到的菜单为准。",
        ],
      },
      {
        heading: "进入配置页",
        steps: [
          "打开 FlClash，点击左侧「配置」。首次使用时，列表可能提示尚无配置文件。",
          {
            text: "点击右下角添加按钮（＋），打开「添加配置」菜单。",
            images: [{ src: "/docs/subscription-import/flclash/config-entry.jpg", alt: "FlClash 配置页及右下角的添加按钮", caption: "先进入「配置」，再点击右下角的＋。" }],
          },
        ],
      },
      {
        heading: "通过 URL 导入",
        steps: [
          {
            text: "在添加配置菜单中选择「URL／通过 URL 获取配置文件」。不要选择「文件」；本站当前交付的是订阅地址。",
            images: [{ src: "/docs/subscription-import/flclash/url-entry.jpg", alt: "FlClash 添加配置菜单，URL 导入入口位于右侧", caption: "添加配置菜单中选择 URL。" }],
          },
          {
            text: "在弹出的 URL 输入框粘贴刚复制的完整地址，检查首尾没有空格，再按客户端按钮提交。地址不要填在搜索框或浏览器地址栏。",
            images: [{ src: "/docs/subscription-import/flclash/url-submit.jpg", alt: "FlClash 从 URL 导入对话框，包含 URL 输入框和提交按钮", caption: "在 URL 输入框粘贴当前线路地址并提交。" }],
          },
          "等待客户端显示导入结果。若提示失败，先回到「当前套餐」重新复制所选线路地址，再检查网络和客户端提示。",
        ],
      },
      {
        heading: "二维码导入（可选）",
        paragraphs: [
          "FlClash 也提供二维码导入入口。本站二维码编码的是订阅 URL，并非单个节点；能否识别取决于客户端版本，识别失败时使用上面的 URL 步骤。",
        ],
        steps: [
          {
            text: "回到「配置」，点击右下角添加按钮（＋）。",
            images: [{ src: "/docs/subscription-import/flclash/config-entry.jpg", alt: "FlClash 配置页及右下角的添加按钮", caption: "回到「配置」，点击右下角的＋。" }],
          },
          {
            text: "在添加配置菜单选择「二维码／扫描二维码获取配置文件」。",
            images: [{ src: "/docs/subscription-import/flclash/qr-entry.jpg", alt: "FlClash 添加配置菜单中的二维码入口", caption: "二维码入口是可选方式；无法识别订阅 URL 时改用 URL 导入。" }],
          },
          "选择保存的二维码图片，由客户端判断能否导入本站订阅 URL。",
        ],
      },
      {
        heading: "启用配置、选择节点",
        paragraphs: [
          {
            text: "导入成功后，在「配置」列表确认出现新配置，并点击它将其设为当前配置。然后进入左侧「代理」，从配置提供的列表中选择需要使用的节点；节点和延迟以客户端实际显示为准。",
            images: [{ src: "/docs/subscription-import/flclash/imported-config.png", alt: "FlClash 成功导入后的配置卡片，示例名称和用量已遮盖", caption: "配置卡片出现后点击它以启用；示例名称和用量已遮盖。" }],
          },
          {
            text: "需要连接时，进入「仪表盘」，按客户端界面开启代理。这里可查看系统代理和「规则／全局／直连」出站模式；这些是连接与分流设置，导入 URL 本身不要求先开启。请选择符合自己设备需要的模式。",
            images: [{ src: "/docs/subscription-import/flclash/start-proxy.png", alt: "FlClash 仪表盘的系统代理与出站模式，示例 IP 已遮盖", caption: "按自己设备需要选择连接和出站模式；示例 IP 已遮盖。" }],
          },
        ],
      },
      {
        heading: "开机自启动（可选）",
        steps: [
          {
            text: "从「工具」进入「应用程序」，查看启动选项。",
            images: [{ src: "/docs/subscription-import/flclash/autolaunch-entry.jpg", alt: "FlClash 工具页中的应用程序入口", caption: "从「工具」打开「应用程序」。" }],
          },
          {
            text: "若需要随系统启动，可在应用程序选项中查看「自启动」；这不是订阅导入的前提。",
            images: [{ src: "/docs/subscription-import/flclash/autolaunch-toggle.jpg", alt: "FlClash 应用程序设置中的自启动选项", caption: "自启动为可选设置。" }],
          },
        ],
      },
      {
        heading: "更新与常见问题",
        paragraphs: [
          {
            text: "订阅内容变化后，回到「配置」页使用右上角刷新入口，再确认当前配置和代理列表。刷新成功与否以客户端提示为准。",
            images: [{ src: "/docs/subscription-import/flclash/refresh-config.png", alt: "FlClash 配置页右上角的刷新入口，示例名称和用量已遮盖", caption: "在配置页点击刷新入口；示例名称和用量已遮盖。" }],
          },
          "配置列表为空时，检查 URL 是否完整、是否选择了当前线路，以及客户端是否给出格式或网络错误。配置出现但代理列表为空时，先刷新配置；仍无结果时向现有支持渠道提供线路名称和客户端错误提示，不要发送完整订阅地址。",
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
        paragraphs: [
          "视频介绍客户端获取和使用；导入本站当前线路时，请按下方图文步骤操作。",
        ],
        video: {
          youtubeId: "BKYbtaMdD6A",
          title: "Shadowrocket 客户端视频",
        },
      },
      {
        heading: "客户端页面示意",
        paragraphs: [
          {
            text: "下图展示 Shadowrocket 的历史 App Store 页面。版本和获取方式以当前官方商店实际显示为准；下面的导入步骤以设备上已有客户端为前提。",
            images: [{ src: "/docs/subscription-import/shadowrocket/app-store.jpg", alt: "Shadowrocket 的历史 App Store 页面", caption: "商店页面示意；版本与上架状态以当前页面为准。" }],
          },
        ],
      },
      {
        heading: "准备地址",
        paragraphs: [
          "在「当前套餐」找到已开通服务卡片；有多条线路时先选定线路，再点击「复制地址」。以下步骤假设设备上已有 Shadowrocket。订阅地址是私密交付信息，不要截图或转发。",
        ],
      },
      {
        heading: "识别首页入口",
        paragraphs: [
          {
            text: "首页可以找到扫码入口。本站的订阅 URL 请按下面的「添加订阅」步骤填写；不要把订阅二维码当成单个节点二维码。",
            images: [{ src: "/docs/subscription-import/shadowrocket/home.png", alt: "Shadowrocket 首页与左上角扫码入口，示例订阅名称已遮盖", caption: "首页可识别扫码和右上角添加入口；示例订阅名称已遮盖。" }],
          },
        ],
      },
      {
        heading: "添加订阅",
        steps: [
          "打开 Shadowrocket 首页，点击右上角添加按钮（＋），进入「添加节点」。",
          {
            text: "在「类型」中选择「Subscribe」，然后在必填的 URL 栏粘贴本站当前线路的订阅地址。备注可填便于自己识别的名称，其他选项先保持默认。",
            images: [{ src: "/docs/subscription-import/shadowrocket/subscribe-form.jpg", alt: "Shadowrocket 添加节点表单，类型为 Subscribe，URL 栏待填写", caption: "选择 Subscribe 类型，在 URL 栏填写地址。" }],
          },
          "点击右上角「完成」。回到首页检查订阅分组是否出现，并展开查看客户端实际导入的节点。不要把本站订阅二维码当成单个节点二维码；优先使用 URL 表单。",
        ],
      },
      {
        heading: "更新订阅",
        steps: [
          {
            text: "打开右下角「设置」→「订阅」。",
            images: [{ src: "/docs/subscription-import/shadowrocket/settings-entry.jpg", alt: "Shadowrocket 设置页面中的订阅入口", caption: "设置页的订阅入口。" }],
          },
          {
            text: "可按需要启用「打开时更新」或后台更新。设置项和更新频率随客户端版本而变化；更新后回到首页确认订阅分组与节点。",
            images: [{ src: "/docs/subscription-import/shadowrocket/update-options.jpg", alt: "Shadowrocket 订阅设置中的打开时更新和自动后台更新选项", caption: "更新选项可根据自己的需要设置。" }],
          },
        ],
      },
      {
        heading: "选择节点并连接",
        paragraphs: [
          "订阅分组出现后，选择需要使用的节点；可在首页使用「连通性测试」查看客户端测得的结果。测试数值只反映当时的探测，连接是否可用仍以实际结果为准。",
          {
            text: "选好节点后，使用首页顶部开关连接。若系统首次弹出 VPN 配置确认，应先核对设备提示和客户端身份，再由你本人决定是否允许。连接成功时以客户端状态和设备实际网络表现为准。",
            images: [{ src: "/docs/subscription-import/shadowrocket/connected.png", alt: "Shadowrocket 首页显示代理已开启，示例订阅名称已遮盖", caption: "首页开关开启后的示意；示例订阅名称已遮盖。" }],
          },
          {
            text: "在「全局路由」中可以查看「配置、代理、直连、场景」。需要按配置规则分流时，可在该页面选择「配置」模式；切换前先了解对当前设备流量的影响。",
            images: [{ src: "/docs/subscription-import/shadowrocket/routing-options.jpg", alt: "Shadowrocket 全局路由页面，显示配置、代理、直连与场景选项", caption: "全局路由可查看不同的流量处理模式。" }],
          },
        ],
      },
      {
        heading: "导入不了？",
        paragraphs: [
          "检查类型是否为 Subscribe、URL 是否完整且没有空格，以及当前线路是否仍有可用交付地址。客户端报格式错误或更新失败时，以它的提示为准；向现有支持渠道提供客户端名称、线路名称和错误文字，不要发送完整 URL。",
        ],
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
          "在「当前套餐」找到已开通服务卡片；有多条线路时先选定线路，再点击「复制地址」。只使用自己的授权地址，不要把完整 URL 发到聊天、工单或截图中。以下以已安装的 Clash Verge 为例。",
        ],
      },
      {
        heading: "在订阅页导入 URL",
        steps: [
          "打开 Clash Verge，点击左侧「订阅」。在页面顶部找到「订阅文件链接」输入框。",
          {
            text: "将本站当前线路 URL 粘贴到这个输入框，不要填入节点名称；检查首尾没有空格，再点击「导入」或当前版本的确认按钮。",
            images: [{ src: "/docs/subscription-import/clash-verge/subscription-entry.png", alt: "Clash Verge 订阅页顶部的订阅文件链接输入框，示例卡片信息已遮盖", caption: "在顶部输入框粘贴订阅 URL；示例订阅卡片信息已遮盖。" }],
          },
          "等待订阅卡片出现。点击刚导入的卡片，把它设为当前使用的配置；如果已存在旧卡片，先核对名称和导入时间，避免选错。",
        ],
        paragraphs: ["配图使用特定版本的界面；按钮名称与位置以你实际安装的客户端为准。"],
      },
      {
        heading: "选择节点",
        paragraphs: [
          {
            text: "点击左侧「代理」，展开配置提供的代理组，从列表中选择需要使用的节点。列表中也可能有「自动选择」「故障转移」等组；它们的行为取决于配置，先确认选中的是自己需要的组与节点。",
            images: [{ src: "/docs/subscription-import/clash-verge/proxy-list.png", alt: "Clash Verge 代理组和节点列表，客户用量已遮盖", caption: "在「代理」中选择当前配置提供的组和节点；客户用量已遮盖。" }],
          },
          "列表与延迟结果来自当前配置和客户端，不能仅凭截图中的示例名称判断自己的节点。若列表为空，返回「订阅」检查配置卡片是否已导入、已选中，以及客户端是否有错误提示。",
        ],
      },
      {
        heading: "连接与模式",
        paragraphs: [
          {
            text: "需要让桌面应用使用代理时，可在客户端首页查看「系统代理」及「规则／全局／直连」模式。是否还需要虚拟网卡模式取决于应用与设备，不能把它当成导入订阅的必需步骤。",
            images: [{ src: "/docs/subscription-import/clash-verge/system-proxy.png", alt: "Clash Verge 首页系统代理开关与代理模式，客户流量已遮盖", caption: "系统代理和规则模式界面；客户连接与流量信息已遮盖。" }],
          },
          "更改系统代理或虚拟网卡会影响设备网络。请按照自己设备与客户端的实际提示操作，连接后通过目标应用验证。关闭代理时也在客户端核对开关状态。",
        ],
      },
      {
        heading: "更新与排查",
        paragraphs: [
          "线路内容变化时回到「订阅」页，找到对应卡片的刷新入口，等待客户端更新并核对当前配置与节点列表。若地址过期或内容格式不受支持，客户端通常会给出错误提示，按提示排查。",
          "导入失败时重新从「当前套餐」复制当前线路 URL，确认没有遗漏字符；仍失败时向现有支持渠道提供线路名称、客户端版本和错误文字，不要发送订阅 URL 或含节点资料的截图。",
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
        heading: "客户端主界面",
        paragraphs: [
          {
            text: "打开 Clash Meta for Android 后，先查看主界面的「配置」入口。界面和按钮位置随版本变化，以你的客户端实际显示为准。",
            images: [{ src: "/docs/subscription-import/clash-meta/home.jpg", alt: "Clash Meta for Android 主界面及配置入口", caption: "主界面和配置入口。" }],
          },
        ],
      },
      {
        heading: "复制订阅地址",
        paragraphs: [
          "在「当前套餐」找到已开通服务卡片；有多条线路时先选定线路，再点击「复制地址」。以下以已安装的 Clash Meta for Android 为例。地址属于私密交付信息，不要转发或填到第三方网页。",
        ],
      },
      {
        heading: "打开配置页",
        steps: [
          {
            text: "打开客户端，在主界面点击「配置」。首次使用时，配置区可能显示「未选择」。",
            images: [{ src: "/docs/subscription-import/clash-meta/config-entry.jpg", alt: "Clash Meta for Android 主界面配置入口和配置页添加按钮", caption: "主界面进入「配置」。" }],
          },
          {
            text: "在配置页点击右上角添加按钮（＋），进入「创建配置」。",
            images: [{ src: "/docs/subscription-import/clash-meta/add-menu.jpg", alt: "Clash Meta for Android 创建配置菜单中的文件与 URL 入口", caption: "点击＋后，创建配置菜单提供文件和 URL 两种方式。" }],
          },
        ],
      },
      {
        heading: "从 URL 导入并保存",
        steps: [
          {
            text: "在「创建配置」中选择「URL／从 URL 导入」，不要选「文件」；本站提供的是当前线路的订阅 URL。",
            images: [{ src: "/docs/subscription-import/clash-meta/url-form.jpg", alt: "Clash Meta for Android 从 URL 导入入口及名称、URL 表单", caption: "选择 URL 导入，填写名称和当前线路地址。" }],
          },
          "在表单中填写便于自己识别的名称，并在 URL 栏粘贴完整订阅地址；检查首尾没有空格后保存。",
          "等待客户端显示新配置。返回配置列表，确认该配置出现并按界面提示将它设为当前配置。导入是否成功，以客户端状态和代理列表为准。",
        ],
      },
      {
        heading: "文件导入方式（对照）",
        paragraphs: [
          {
            text: "客户端也提供从本地文件创建配置的入口。本站当前提供订阅 URL，请按上面的 URL 步骤操作。",
            images: [{ src: "/docs/subscription-import/clash-meta/file-form.jpg", alt: "Clash Meta for Android 从本地文件导入配置的对照界面", caption: "本地文件导入方式；本站订阅使用 URL。" }],
          },
        ],
      },
      {
        heading: "启动连接",
        paragraphs: [
          {
            text: "确认配置已激活后，回到主界面，点击顶部「已停止／点击启动」。Android 若出现 VPN 连接请求，请核对来源和内容，由你本人决定是否允许。",
            images: [{ src: "/docs/subscription-import/clash-meta/start-connection.jpg", alt: "Clash Meta for Android 主界面启动按钮及 Android VPN 连接请求", caption: "配置激活后点击启动；系统连接请求由你核对并决定。" }],
          },
          {
            text: "客户端随后可能显示「运行中」状态；仍应通过实际应用确认连接效果。",
            images: [{ src: "/docs/subscription-import/clash-meta/running.jpg", alt: "Clash Meta for Android 主界面的运行中状态", caption: "客户端显示「运行中」时，再检查实际连接效果。" }],
          },
        ],
      },
      {
        heading: "选择节点与模式",
        paragraphs: [
          {
            text: "进入「代理」查看当前配置提供的组和节点，按自己的需要选择。",
            images: [{ src: "/docs/subscription-import/clash-meta/node-list.jpg", alt: "Clash Meta for Android 代理页中的组与节点列表", caption: "进入代理页，从当前配置的列表中选择节点。" }],
          },
          {
            text: "在代理页打开模式菜单；规则、全局和直连会影响不同流量的处理方式，切换前请确认用途。",
            images: [{ src: "/docs/subscription-import/clash-meta/mode-menu.jpg", alt: "Clash Meta for Android 代理页的模式菜单", caption: "代理模式入口与可选模式以客户端实际显示为准。" }],
          },
        ],
      },
      {
        heading: "更新与常见问题",
        paragraphs: [
          "需要获取线路更新时，回到配置页找到当前配置的更新入口，再确认代理列表。若配置不出现或列表为空，检查 URL 是否完整、当前配置是否已选中，以及客户端提示的网络或格式错误。",
          "本站二维码编码的是订阅 URL，不保证扫码入口接受。扫码无效时使用 URL 导入；仍有问题时向现有支持渠道提供线路名称、客户端版本和错误文字，不要发送完整订阅地址。",
        ],
      },
    ],
  },
  {
    id: "proxy-tool-downloads",
    category: "代理工具下载",
    title: "代理工具下载",
    summary: "按设备系统选择客户端并下载。",
    sections: [
      {
        paragraphs: [
          "请按设备系统和处理器类型选择客户端。点击具体「前往下载」会打开第三方页面；下载前请核对文件名、版本和设备兼容性。",
        ],
      },
      {
        heading: "Windows",
        links: [
          { label: "Clash Verge · x64", url: "https://99data.qqx.me/f/vaC7/Clash.Verge_2.5.1_x64-setup.exe" },
          { label: "Clash Verge · x64 内置 WebView2", url: "https://99data.qqx.me/f/LRh3/Clash.Verge_2.5.1_x64_fixed_webview2-setup.exe" },
          { label: "FlClash · Windows", url: "https://99data.qqx.me/s/G9hL" },
        ],
      },
      {
        heading: "macOS",
        links: [
          { label: "Clash Verge · Apple 芯片", url: "https://99data.qqx.me/f/MdiJ/Clash.Verge_2.5.1_aarch64.dmg" },
          { label: "Clash Verge · Intel 芯片", url: "https://99data.qqx.me/f/apcn/Clash.Verge_2.5.1_x64.dmg" },
          { label: "FlClash · Apple 芯片", url: "https://99data.qqx.me/s/RgT8" },
          { label: "FlClash · Intel 芯片", url: "https://99data.qqx.me/s/EeCv" },
        ],
      },
      {
        heading: "Linux",
        links: [
          { label: "Clash Verge · amd64 DEB", url: "https://99data.qqx.me/f/7bsY/Clash.Verge_2.5.1_amd64.deb" },
          { label: "Clash Verge · x86_64 RPM", url: "https://99data.qqx.me/f/j6UE/Clash.Verge-2.5.1-1.x86_64.rpm" },
          { label: "FlClash · Linux", url: "https://99data.qqx.me/s/ObUM" },
        ],
      },
      {
        heading: "Android",
        links: [
          { label: "v2rayNG · arm64-v8a", url: "https://99data.qqx.me/f/WATj/v2rayNG_2.1.8-fdroid_arm64-v8a.apk" },
          { label: "Clash Meta · arm64-v8a", url: "https://99data.qqx.me/f/VRIl/cmfa-2.11.28-meta-arm64-v8a-release.apk" },
          { label: "FlClash · Android", url: "https://99data.qqx.me/s/2Yie" },
        ],
      },
    ],
  },
  {
    id: "social-ai-environment-setup",
    category: "进阶教程",
    title: "社媒、ChatGPT 与 Claude：电脑和手机环境设置",
    summary: "按设备检查订阅、流量接入和应用可用性，并区分网络连接与平台账号问题。",
    sections: [
      {
        heading: "开始前先确认",
        paragraphs: [
          "使用可信来源的客户端、本人有效的服务订阅和本人账号。先确认订阅能在客户端正常更新，再查目标平台的官方使用地区与账号要求。网络连通不等于具备账号资格，也不代表平台一定支持当前地区或功能。",
          "没有适用于所有设备的节点、TUN 或全局模式设置；任何连接方式都不能保证平台解锁、账号不受限制或服务始终可用。请遵守各平台规则，不借助位置伪装、指纹伪装、共享账号或不可信证书处理访问限制。",
        ],
      },
      {
        heading: "Windows 与 macOS：先接入，再验证",
        steps: [
          {
            text: "按本站现有的「Clash Verge：导入并选择配置」教程导入本人订阅，确认配置已选中，再从配置提供的列表选择节点。客户端显示节点或延迟，只能说明对应步骤有结果。",
            images: [
              { src: "/docs/social-ai-setup/desktop-subscriptions.png", alt: "Clash Verge 订阅页与配置卡片；原图含私密信息，仅本机查看", caption: "先确认订阅已导入并选中。原图未遮挡，仅限本机预览，请勿转发。" },
              { src: "/docs/social-ai-setup/desktop-proxy.png", alt: "Clash Verge 代理组与当前选中节点；原图含私密信息，仅本机查看", caption: "在当前配置的代理组中查看节点；截图状态不是通用推荐。" },
            ],
          },
          {
            text: "先保留现有规则模式，按客户端说明开启系统代理，再用实际浏览器打开目标平台官网验证。若目标应用不遵循系统代理，才考虑客户端官方说明中的 TUN 模式；系统级授权提示由本人核对并决定，不为了初次连接去关闭防火墙或其他保护。",
            images: [
              { src: "/docs/social-ai-setup/desktop-home.png", alt: "Clash Verge 首页显示系统代理、虚拟网卡和路由模式；原图含私密信息，仅本机查看", caption: "分别核对流量接入与路由模式；图中开关只是原设备当时状态。" },
              { src: "/docs/social-ai-setup/desktop-settings.png", alt: "Clash Verge 设置页显示系统代理、虚拟网卡与其他选项", caption: "到设置页核对现有开关，不照抄示例状态。" },
            ],
          },
          "区分两件事：系统代理或 TUN 决定应用流量如何进入客户端；规则、全局或直连决定已进入客户端的流量如何出去。全局模式只作用于已接入的流量，系统代理绕过和 TUN 排除仍可能让部分请求不经过客户端。",
        ],
        paragraphs: [
          "有的示例界面同时显示「TUN 已开、系统代理已关、全局已选」，它只是某台设备当时的状态，不是推荐所有人照抄的组合。以当前应用是否被接入、现有规则和实际页面结果为准。参考 Clash Verge Rev 官方《快速入门》《名词解释》《Bypass》。",
        ],
      },
      {
        heading: "iPhone 与 iPad：沿用已有订阅和配置",
        steps: [
          {
            text: "已使用 Shadowrocket 的用户，先按本站「Shadowrocket：添加订阅 URL」教程导入本人地址、选择节点，再用首页连接开关连接。系统若要求添加 VPN 配置，由本人核对客户端及系统提示后决定。",
            images: [{ src: "/docs/social-ai-setup/ios-home.png", alt: "Shadowrocket 首页显示连接开关、全局路由和节点列表；原图含私密信息，仅本机查看", caption: "首页用于核对连接与路由入口。原图未遮挡，仅限本机预览，请勿转发。" }],
          },
          {
            text: "保留已有可用的「全局路由」配置；需要按现有配置规则分流时，可参照本站原教程查看「配置」模式。不要只凭示例截图推断其他模式或把某个开关状态当作通用答案。",
            images: [{ src: "/docs/social-ai-setup/ios-general.png", alt: "Shadowrocket 通用设置页显示旁路系统、IPv6、私有 IP 应答和 DNS 选项；原图含私密信息，仅本机查看", caption: "这些是可核对的设置入口，图中的开关状态不适合直接照抄。" }],
          },
          {
            text: "分别在 Wi-Fi 和蜂窝网络下用目标应用检查实际页面或请求。网络切换后重新确认连接状态；连接开关打开、节点测速成功或选了「始终开启」，都不等于永不掉线，也不证明每个请求都已进入客户端。",
            images: [{ src: "/docs/social-ai-setup/ios-on-demand.png", alt: "Shadowrocket 按需求连接页显示始终开启、按需求连接与睡眠时断开", caption: "按设备需要审查这些选项，不把「始终开启」当成永不掉线保证。" }],
          },
        ],
        paragraphs: [
          "示例设置页可能出现「旁路系统、启用 IPv6、首选 IPv6、私有 IP 应答、DNS 覆写、备用 DNS、始终开启、按需求连接、睡眠时断开」等标签。它们仅是核对当前配置的入口，不代表截图中的开关状态适合你的设备；不要一律关闭 IPv6、强制第三方 DNS 或关闭旁路。参考 Shadowrocket 的官方 App Store 页面。",
        ],
      },
      {
        heading: "Android：核对 VPN 权限和应用范围",
        steps: [
          "使用已可信安装的客户端，按本站已有的 FlClash 导入教程取得本人订阅并选好配置与节点；不同 Android 客户端的菜单以实际版本为准。",
          "首次启动时如出现 Android VPN 连接请求，由本人核对并批准。若客户端提供按应用分流，检查目标社媒或 AI 应用是否包含在需要的应用范围内，再用该应用本身验证。",
          "「始终开启 VPN」和「阻止不使用 VPN 的连接」可能改变断线时的可用性，不是初次设置的必选项；先了解设备与客户端当前配置，再决定是否使用。",
        ],
        paragraphs: [
          "参考 Android 官方 VPN 帮助；不要把系统的 VPN 标记当成目标应用已经成功访问的证明。",
        ],
      },
      {
        heading: "社媒、ChatGPT 与 Claude：以官方页面为准",
        paragraphs: [
          "从平台官方网站或官方应用商店进入，使用本人账号，完成平台要求的登录与多因素验证，并检查设备时间是否正确。单独的浏览器配置文件可以帮助区分日常会话，但不保证账号之间不会关联，也不能替代平台的使用资格。",
          "用目标网页或应用的实际页面与请求判断是否可用。Ping、节点延迟或 YouTube 能打开，都不能证明社媒、ChatGPT 或 Claude 的账号和功能可用；网络正常而页面仍拒绝访问时，应查看平台官方状态、支持与账号提示。",
          "聊天订阅与开发者 API 是不同的产品、认证和计费入口；不要为了排查网页或应用问题去开通 API 或付款。参考 ChatGPT 官方 Quickstart、Claude 官方入门与支持地区说明。",
        ],
      },
      {
        heading: "按层排查并保护私密资料",
        steps: [
          "先看订阅是否有效、配置是否已选中、节点与连接状态是否正常；再看目标浏览器或应用的流量是否进入客户端。不要靠不停换节点代替定位问题。",
          "连接或 DNS 错误先核对本机连接与客户端提示；HTTP 403 可能涉及平台地区、账号或其他访问策略，HTTP 429 通常需要检查额度或请求频率；验证码与登录提示应按平台本人流程处理。不要把这些不同问题一概归为节点故障。",
          "仍无法判断时查看目标平台官方状态或支持渠道，只提交脱敏后的错误文字、发生时间和设备/客户端版本。不要发送完整订阅 URL、验证码、账号凭据或包含真实地址与用量的截图；不要清空用户数据或关闭安全保护作为常规排障步骤。",
        ],
      },
      {
        heading: "参考资料",
        paragraphs: [
          "Clash Verge Rev 官方：快速入门 https://www.clashverge.dev/guide/quickstart.html；名词解释 https://www.clashverge.dev/guide/term.html；Bypass https://www.clashverge.dev/guide/bypass.html。",
          "Apple App Store：Shadowrocket https://apps.apple.com/us/app/shadowrocket/id932747118；Android 官方 VPN 帮助 https://support.google.com/android/answer/9089766?hl=en。",
          "ChatGPT 官方 Quickstart https://learn.chatgpt.com/docs/quickstart；Claude 官方入门 https://support.claude.com/en/articles/8114491-get-started-with-claude；支持地区 https://support.claude.com/en/articles/8461763-where-can-i-access-claude。",
          "Claude 帮助中心：聊天订阅与 Console API 的区别 https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-is-claude-api-usage-billed-separately-from-my-paid-claude-plan。",
        ],
      },
    ],
  },
];

const GUIDE_CATEGORY_IDS: Readonly<Record<string, DocumentationCategoryId>> = {
  订阅导入: "subscription-import",
  代理工具下载: "proxy-tool-downloads",
  进阶教程: "advanced",
};

export const SUBSCRIPTION_IMPORT_ARTICLES: readonly DocumentationArticle[] = [
  ...ZH_GUIDE_ARTICLES.map((article) => ({
    ...article,
    categoryId: GUIDE_CATEGORY_IDS[article.category],
    en: SUBSCRIPTION_IMPORT_ARTICLES_EN[article.id],
  })),
  ...ADVANCED_NOTES.map((note): DocumentationArticle => ({
    id: note.id,
    categoryId: "advanced",
    category: "进阶教程",
    title: note.title,
    summary: note.summary,
    sections: [],
    note,
    en: { category: "Advanced guides", title: note.en.title, summary: note.en.summary, sections: [] },
  })),
];

/** Reader view in one language. Chinese returns the articles unchanged; English swaps in the
    `en` text (and the note's English body) and falls back to Chinese where none exists. */
export function localizeDocumentationArticles(
  articles: readonly DocumentationArticle[],
  lang: DocsLang,
): readonly DocumentationArticle[] {
  if (lang === "zh") return articles;
  return articles.map((article) => {
    const text = article.en;
    const note = article.note;
    return {
      ...article,
      ...(text === undefined ? {} : {
        category: text.category,
        title: text.title,
        summary: text.summary,
        sections: text.sections,
      }),
      ...(note === undefined ? {} : {
        note: {
          ...note,
          title: note.en.title,
          summary: note.en.summary,
          body: note.en.body,
          editorNote: note.en.editorNote,
        },
      }),
    };
  });
}

export function documentationCategoryKey(article: DocumentationArticle): string {
  return article.categoryId ?? article.category;
}

export type NoteLineKind = "hidden" | "gap" | "bullet" | "heading" | "paragraph";

/** How the advanced-note renderer shows one line of a body part (text between image placeholders).
    Headings are short bold-led lines without sentence punctuation (「。」, or an English sentence
    end such as ". " / a trailing "." or "!"); numbering like "1." or "2.2" is not a sentence end, and a
    question mark is allowed because headings are often questions. */
export function noteLineKind(line: string, index: number, firstPart: boolean, title: string): NoteLineKind {
  const trimmed = line.trim();
  const plain = trimmed.replaceAll("**", "");
  if (firstPart && index === 0 && plain === title) return "hidden";
  if (trimmed === "" || trimmed === "****" || trimmed === "**") return "gap";
  if (/^\s*\*\s+/.test(line)) return "bullet";
  const unnumbered = plain.replace(/^\s*\d+(?:\.\d+)*\.?\s*/, "");
  if (
    (trimmed.startsWith("**") || (firstPart && index === 1 && trimmed.endsWith("**"))) &&
    plain.length < 85 &&
    !plain.includes("。") &&
    !/[.!](?:\s|$)/.test(unnumbered)
  ) {
    return "heading";
  }
  return "paragraph";
}

export type StructuredLineKind = "gap" | "section" | "subsection" | "bullet" | "nested-bullet" | "paragraph";

/** Structured notes: 「一、」 (or "I." … "VII." in English) open a section, "1." … "5." a subsection. */
export function structuredLineKind(line: string): StructuredLineKind {
  const text = line.trimStart();
  if (text === "") return "gap";
  if (/^(?:[一二三四五六七]、|(?:I|II|III|IV|V|VI|VII)\.)\s/.test(text)) return "section";
  if (/^[1-5]\.\s/.test(text)) return "subsection";
  if (text.startsWith("⚬")) return line.startsWith("  ") ? "nested-bullet" : "bullet";
  return "paragraph";
}

function searchableArticleText(article: DocumentationArticle): string {
  const sectionText = article.sections.flatMap((section) => [
    section.heading ?? "",
    ...(section.paragraphs ?? []).flatMap((item) =>
      typeof item === "string" ? [item] : [item.text, ...item.images.flatMap((image) => [image.alt, image.caption])]
    ),
    ...(section.steps ?? []).flatMap((item) =>
      typeof item === "string" ? [item] : [item.text, ...item.images.flatMap((image) => [image.alt, image.caption])]
    ),
    ...(section.links ?? []).map((link) => link.label),
    ...(section.images ?? []).flatMap((image) => [image.alt, image.caption]),
    section.video?.title ?? "",
  ]);
  return [article.title, article.summary, article.category, ...sectionText, article.note?.body ?? ""]
    .join("\n")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN");
}

export function documentCategories(articles: readonly DocumentationArticle[]): readonly string[] {
  return [...new Set(articles.map((article) => article.category))];
}

/** Directory groups in article order, keyed by the stable category id. */
export function documentGroups(
  articles: readonly DocumentationArticle[],
): readonly { readonly key: string; readonly name: string; readonly articles: readonly DocumentationArticle[] }[] {
  const groups = new Map<string, { key: string; name: string; articles: DocumentationArticle[] }>();
  for (const article of articles) {
    const key = documentationCategoryKey(article);
    const group = groups.get(key) ?? { key, name: article.category, articles: [] };
    group.articles.push(article);
    groups.set(key, group);
  }
  return [...groups.values()];
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

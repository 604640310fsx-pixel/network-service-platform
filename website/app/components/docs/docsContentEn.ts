// English versions of the client tutorials and the download guide.
// Each entry mirrors the Chinese article in docsModel.ts section by section: the same
// image src order, link URLs and video id (tests enforce the parity). The screenshots
// show the Chinese client UI, so the steps name the English label first and the
// Chinese label in parentheses where it helps match the picture.
import type { LocalizedArticleText } from "./docsModel";

export const SUBSCRIPTION_IMPORT_ARTICLES_EN: Readonly<Record<string, LocalizedArticleText>> = {
  "flclash-import": {
    category: "Subscription import",
    title: "FlClash: import a subscription by URL",
    summary: "Add the subscription URL of your current line on FlClash's Profiles page and check the result.",
    sections: [
      {
        heading: "Get the subscription URL",
        paragraphs: [
          "Open “My plans” and find the card of your active service. If it has several lines, pick a line first, then click “Copy address”. The URL is private delivery information: do not send it to anyone or paste it into third-party websites.",
          "The steps below use an installed copy of FlClash. The client UI may change between versions, so go by the menus you actually see.",
        ],
      },
      {
        heading: "Open the Profiles page",
        steps: [
          "Open FlClash and click “Profiles” (配置) on the left. On first use, the list may say there are no profiles yet.",
          {
            text: "Click the add button (＋) in the bottom-right corner to open the “Add profile” menu.",
            images: [{ src: "/docs/subscription-import/flclash/config-entry.jpg", alt: "FlClash Profiles page with the add button in the bottom-right corner", caption: "Open “Profiles”, then click ＋ in the bottom-right corner." }],
          },
        ],
      },
      {
        heading: "Import by URL",
        steps: [
          {
            text: "In the add menu, choose “URL / Get profile from URL”. Do not choose “File”: what we deliver is a subscription URL.",
            images: [{ src: "/docs/subscription-import/flclash/url-entry.jpg", alt: "FlClash add-profile menu with the URL import entry on the right", caption: "Choose URL in the add-profile menu." }],
          },
          {
            text: "Paste the full URL you just copied into the URL box, check there are no spaces at either end, then submit with the client's button. Do not paste the URL into a search box or the browser address bar.",
            images: [{ src: "/docs/subscription-import/flclash/url-submit.jpg", alt: "FlClash import-from-URL dialog with the URL field and submit button", caption: "Paste the current line's URL into the URL field and submit." }],
          },
          "Wait for the client to show the import result. If it reports a failure, go back to “My plans”, copy the selected line's URL again, then check your network and the client's message.",
        ],
      },
      {
        heading: "Import by QR code (optional)",
        paragraphs: [
          "FlClash also has a QR code import entry. Our QR code encodes the subscription URL, not a single node; whether it is recognised depends on the client version. If it fails, use the URL steps above.",
        ],
        steps: [
          {
            text: "Go back to “Profiles” and click the add button (＋) in the bottom-right corner.",
            images: [{ src: "/docs/subscription-import/flclash/config-entry.jpg", alt: "FlClash Profiles page with the add button in the bottom-right corner", caption: "Back on “Profiles”, click ＋ in the bottom-right corner." }],
          },
          {
            text: "In the add menu, choose “QR code / Scan QR code to get profile”.",
            images: [{ src: "/docs/subscription-import/flclash/qr-entry.jpg", alt: "QR code entry in FlClash's add-profile menu", caption: "QR code import is optional; if the subscription URL is not recognised, use URL import instead." }],
          },
          "Select the saved QR code image and let the client decide whether it can import our subscription URL.",
        ],
      },
      {
        heading: "Activate the profile and choose a node",
        paragraphs: [
          {
            text: "After a successful import, check that the new profile appears in the “Profiles” list and click it to make it the current profile. Then open “Proxies” (代理) on the left and pick the node you need from the list the profile provides; nodes and latency are whatever the client actually shows.",
            images: [{ src: "/docs/subscription-import/flclash/imported-config.png", alt: "FlClash profile card after a successful import, example name and usage masked", caption: "Click the profile card once it appears to activate it; example name and usage are masked." }],
          },
          {
            text: "When you want to connect, open “Dashboard” (仪表盘) and turn the proxy on in the client. Here you can also see the system proxy and the “Rule / Global / Direct” outbound modes; these are connection and routing settings, and importing the URL does not require turning them on first. Choose the mode that suits your device.",
            images: [{ src: "/docs/subscription-import/flclash/start-proxy.png", alt: "FlClash dashboard with system proxy and outbound mode, example IP masked", caption: "Choose the connection and outbound mode your device needs; example IP is masked." }],
          },
        ],
      },
      {
        heading: "Launch at startup (optional)",
        steps: [
          {
            text: "From “Tools” (工具), open “Application” (应用程序) to see the startup options.",
            images: [{ src: "/docs/subscription-import/flclash/autolaunch-entry.jpg", alt: "Application entry on FlClash's Tools page", caption: "Open “Application” from “Tools”." }],
          },
          {
            text: "If you want it to start with the system, look for “Auto launch” (自启动) in the application options; it is not required for importing the subscription.",
            images: [{ src: "/docs/subscription-import/flclash/autolaunch-toggle.jpg", alt: "Auto-launch option in FlClash's application settings", caption: "Auto launch is optional." }],
          },
        ],
      },
      {
        heading: "Updates and common issues",
        paragraphs: [
          {
            text: "When the subscription content changes, go back to “Profiles”, use the refresh button in the top-right corner, then check the current profile and the proxy list. Whether the refresh succeeded is shown by the client.",
            images: [{ src: "/docs/subscription-import/flclash/refresh-config.png", alt: "Refresh button in the top-right of FlClash's Profiles page, example name and usage masked", caption: "Click refresh on the Profiles page; example name and usage are masked." }],
          },
          "If the profile list is empty, check that the URL is complete, that you chose the current line, and whether the client shows a format or network error. If the profile appears but the proxy list is empty, refresh the profile first; if there is still nothing, give our existing support channel the line name and the client's error message. Do not send the full subscription URL.",
        ],
      },
    ],
  },
  "shadowrocket-import": {
    category: "Subscription import",
    title: "Shadowrocket: add a subscription URL",
    summary: "Fill in the URL of your current line in Shadowrocket's Subscribe form.",
    sections: [
      {
        paragraphs: [
          "The video introduces getting and using the client; to import your current line, follow the illustrated steps below.",
        ],
        video: {
          youtubeId: "BKYbtaMdD6A",
          title: "Shadowrocket client video",
        },
      },
      {
        heading: "Client page for reference",
        paragraphs: [
          {
            text: "The image shows an earlier App Store page for Shadowrocket. Versions and availability are whatever the official store currently shows; the import steps below assume the client is already on your device.",
            images: [{ src: "/docs/subscription-import/shadowrocket/app-store.jpg", alt: "Earlier App Store page for Shadowrocket", caption: "Store page for reference; check the current page for version and availability." }],
          },
        ],
      },
      {
        heading: "Get the URL",
        paragraphs: [
          "Open “My plans” and find the card of your active service. If it has several lines, pick a line first, then click “Copy address”. The steps below assume Shadowrocket is already on your device. The subscription URL is private delivery information: do not screenshot or forward it.",
        ],
      },
      {
        heading: "Find the entries on the home screen",
        paragraphs: [
          {
            text: "The home screen has a scan entry. Enter our subscription URL with the “Add subscription” steps below; do not treat the subscription QR code as a single-node QR code.",
            images: [{ src: "/docs/subscription-import/shadowrocket/home.png", alt: "Shadowrocket home screen with the scan entry in the top-left, example subscription name masked", caption: "The home screen shows the scan entry and the add button in the top-right; example subscription name masked." }],
          },
        ],
      },
      {
        heading: "Add the subscription",
        steps: [
          "Open the Shadowrocket home screen and tap the add button (＋) in the top-right corner to open “Add Node” (添加节点).",
          {
            text: "Set “Type” to “Subscribe”, then paste your current line's subscription URL into the required URL field. Use any remark that helps you recognise it, and leave the other options at their defaults.",
            images: [{ src: "/docs/subscription-import/shadowrocket/subscribe-form.jpg", alt: "Shadowrocket Add Node form with Type set to Subscribe and the URL field still empty", caption: "Choose the Subscribe type and fill in the URL field." }],
          },
          "Tap “Done” in the top-right corner. Back on the home screen, check that the subscription group appears and expand it to see the nodes the client actually imported. Do not treat our subscription QR code as a single-node QR code; prefer the URL form.",
        ],
      },
      {
        heading: "Update the subscription",
        steps: [
          {
            text: "Open “Settings” in the bottom-right corner → “Subscription”.",
            images: [{ src: "/docs/subscription-import/shadowrocket/settings-entry.jpg", alt: "Subscription entry on Shadowrocket's Settings page", caption: "The subscription entry on the Settings page." }],
          },
          {
            text: "Turn on “Update on open” or background updates if you want them. The options and update frequency vary between client versions; after an update, go back to the home screen and check the subscription group and nodes.",
            images: [{ src: "/docs/subscription-import/shadowrocket/update-options.jpg", alt: "Update-on-open and automatic background update options in Shadowrocket's subscription settings", caption: "Set the update options to suit your needs." }],
          },
        ],
      },
      {
        heading: "Choose a node and connect",
        paragraphs: [
          "Once the subscription group appears, choose the node you need; you can run the “Connectivity Test” on the home screen to see what the client measures. The test values only reflect that moment's probe; whether the connection works is decided by actual use.",
          {
            text: "After choosing a node, connect with the switch at the top of the home screen. If the system asks you to confirm a VPN configuration the first time, check the device prompt and the client's identity first, then decide yourself whether to allow it. A successful connection is shown by the client's status and how your device's network actually behaves.",
            images: [{ src: "/docs/subscription-import/shadowrocket/connected.png", alt: "Shadowrocket home screen showing the proxy turned on, example subscription name masked", caption: "The home screen after turning the switch on; example subscription name masked." }],
          },
          {
            text: "“Global Routing” (全局路由) shows the “Config, Proxy, Direct, Scene” options. To route traffic by the profile's rules, choose “Config” there; understand how switching affects your device's traffic before you change it.",
            images: [{ src: "/docs/subscription-import/shadowrocket/routing-options.jpg", alt: "Shadowrocket Global Routing page showing the Config, Proxy, Direct and Scene options", caption: "Global Routing shows the different traffic-handling modes." }],
          },
        ],
      },
      {
        heading: "Import not working?",
        paragraphs: [
          "Check that the type is Subscribe, that the URL is complete with no spaces, and that the current line still has a valid delivery URL. If the client reports a format error or a failed update, go by its message; give our existing support channel the client name, line name and the error text. Do not send the full URL.",
        ],
      },
    ],
  },
  "clash-verge-import": {
    category: "Subscription import",
    title: "Clash Verge: import and select a profile",
    summary: "Paste your current line's URL on the Profiles page and confirm the imported profile in the client.",
    sections: [
      {
        heading: "Get your current line's URL",
        paragraphs: [
          "Open “My plans” and find the card of your active service. If it has several lines, pick a line first, then click “Copy address”. Only use your own authorised URL, and never put the full URL into chats, tickets or screenshots. The steps below use an installed copy of Clash Verge.",
        ],
      },
      {
        heading: "Import the URL on the Profiles page",
        steps: [
          "Open Clash Verge and click “Profiles” (订阅) on the left. Find the “Profile URL” (订阅文件链接) box at the top of the page.",
          {
            text: "Paste your current line's URL into this box, not a node name; check there are no spaces at either end, then click “Import” or your version's confirm button.",
            images: [{ src: "/docs/subscription-import/clash-verge/subscription-entry.png", alt: "Profile URL box at the top of Clash Verge's Profiles page, example card details masked", caption: "Paste the subscription URL into the box at the top; example profile card details masked." }],
          },
          "Wait for the profile card to appear. Click the card you just imported to make it the profile in use; if an older card already exists, check the name and import time so you don't pick the wrong one.",
        ],
        paragraphs: ["The screenshots show one particular version; button names and positions follow the client you actually installed."],
      },
      {
        heading: "Choose a node",
        paragraphs: [
          {
            text: "Click “Proxies” (代理) on the left, expand the proxy group the profile provides and choose the node you need. The list may also contain groups such as “Auto select” or “Fallback”; how they behave depends on the profile, so make sure you selected the group and node you want.",
            images: [{ src: "/docs/subscription-import/clash-verge/proxy-list.png", alt: "Clash Verge proxy groups and node list, customer usage masked", caption: "Choose a group and node from the current profile under “Proxies”; customer usage masked." }],
          },
          "The list and latency results come from your current profile and client; do not judge your own nodes from the example names in the screenshot. If the list is empty, go back to “Profiles” and check that the profile card was imported and selected, and whether the client shows an error.",
        ],
      },
      {
        heading: "Connection and modes",
        paragraphs: [
          {
            text: "If desktop apps should use the proxy, check “System Proxy” and the “Rule / Global / Direct” modes on the client's home page. Whether you also need TUN (virtual network adapter) mode depends on your apps and device; it is not a required step for importing the subscription.",
            images: [{ src: "/docs/subscription-import/clash-verge/system-proxy.png", alt: "Clash Verge home page with the system proxy switch and proxy mode, customer traffic masked", caption: "System proxy and rule mode; customer connection and traffic details masked." }],
          },
          "Changing the system proxy or the virtual adapter affects your device's network. Follow the actual prompts of your device and client, and check with the target app after connecting. When you turn the proxy off, also confirm the switch state in the client.",
        ],
      },
      {
        heading: "Updates and troubleshooting",
        paragraphs: [
          "When the line content changes, go back to “Profiles”, use the refresh button on the matching card, wait for the client to update, and check the current profile and node list. If the URL has expired or the format is not supported, the client usually shows an error; follow it.",
          "If the import fails, copy the current line's URL again from “My plans” and make sure no characters are missing; if it still fails, give our existing support channel the line name, client version and error text. Do not send the subscription URL or screenshots containing node details.",
        ],
      },
    ],
  },
  "clash-meta-import": {
    category: "Subscription import",
    title: "Clash Meta for Android: create a profile from a URL",
    summary: "Choose URL on the Android client's profile page and save your current line's subscription URL.",
    sections: [
      {
        heading: "Client home screen",
        paragraphs: [
          {
            text: "After opening Clash Meta for Android, find the “Profile” (配置) entry on the home screen. The layout and button positions change between versions, so go by what your client actually shows.",
            images: [{ src: "/docs/subscription-import/clash-meta/home.jpg", alt: "Clash Meta for Android home screen and Profile entry", caption: "The home screen and the Profile entry." }],
          },
        ],
      },
      {
        heading: "Copy the subscription URL",
        paragraphs: [
          "Open “My plans” and find the card of your active service. If it has several lines, pick a line first, then click “Copy address”. The steps below use an installed copy of Clash Meta for Android. The URL is private delivery information: do not forward it or enter it on third-party web pages.",
        ],
      },
      {
        heading: "Open the profile page",
        steps: [
          {
            text: "Open the client and tap “Profile” on the home screen. On first use, the profile area may show “Not selected”.",
            images: [{ src: "/docs/subscription-import/clash-meta/config-entry.jpg", alt: "Profile entry on the Clash Meta for Android home screen and the add button on the profile page", caption: "Open “Profile” from the home screen." }],
          },
          {
            text: "On the profile page, tap the add button (＋) in the top-right corner to open “Create Profile” (创建配置).",
            images: [{ src: "/docs/subscription-import/clash-meta/add-menu.jpg", alt: "File and URL entries in Clash Meta for Android's Create Profile menu", caption: "After tapping ＋, Create Profile offers File and URL." }],
          },
        ],
      },
      {
        heading: "Import from a URL and save",
        steps: [
          {
            text: "In “Create Profile”, choose “URL / Import from URL”, not “File”: we provide a subscription URL for your current line.",
            images: [{ src: "/docs/subscription-import/clash-meta/url-form.jpg", alt: "Clash Meta for Android import-from-URL entry with the name and URL form", caption: "Choose URL import and fill in a name and your current line's URL." }],
          },
          "Enter a name that helps you recognise it, paste the full subscription URL into the URL field, check there are no spaces at either end, and save.",
          "Wait for the client to show the new profile. Go back to the profile list, check that it appears, and set it as the current profile as the UI prompts. Whether the import worked is shown by the client's status and the proxy list.",
        ],
      },
      {
        heading: "File import (for comparison)",
        paragraphs: [
          {
            text: "The client can also create a profile from a local file. We provide a subscription URL, so follow the URL steps above.",
            images: [{ src: "/docs/subscription-import/clash-meta/file-form.jpg", alt: "Clash Meta for Android screen for importing a profile from a local file, for comparison", caption: "Local file import; our subscription uses a URL." }],
          },
        ],
      },
      {
        heading: "Start the connection",
        paragraphs: [
          {
            text: "Once the profile is active, go back to the home screen and tap “Stopped / Tap to start” at the top. If Android shows a VPN connection request, check where it comes from and what it says, then decide yourself whether to allow it.",
            images: [{ src: "/docs/subscription-import/clash-meta/start-connection.jpg", alt: "Start button on the Clash Meta for Android home screen and Android's VPN connection request", caption: "Tap start once the profile is active; you check and decide on the system's connection request." }],
          },
          {
            text: "The client may then show “Running”; still confirm the connection with the apps you actually use.",
            images: [{ src: "/docs/subscription-import/clash-meta/running.jpg", alt: "Running status on the Clash Meta for Android home screen", caption: "When the client shows “Running”, check how the connection actually works." }],
          },
        ],
      },
      {
        heading: "Choose a node and mode",
        paragraphs: [
          {
            text: "Open “Proxy” (代理) to see the groups and nodes the current profile provides, and choose what you need.",
            images: [{ src: "/docs/subscription-import/clash-meta/node-list.jpg", alt: "Groups and node list on Clash Meta for Android's Proxy page", caption: "On the Proxy page, choose a node from the current profile's list." }],
          },
          {
            text: "Open the mode menu on the Proxy page; Rule, Global and Direct handle different traffic differently, so be sure what you need before switching.",
            images: [{ src: "/docs/subscription-import/clash-meta/mode-menu.jpg", alt: "Mode menu on Clash Meta for Android's Proxy page", caption: "The mode entry and available modes are whatever your client shows." }],
          },
        ],
      },
      {
        heading: "Updates and common issues",
        paragraphs: [
          "To get line updates, go back to the profile page, use the current profile's update option, then check the proxy list. If the profile does not appear or the list is empty, check that the URL is complete, that the current profile is selected, and any network or format error the client reports.",
          "Our QR code encodes the subscription URL and is not guaranteed to work with the scan entry. If scanning does not work, use URL import; if problems remain, give our existing support channel the line name, client version and error text. Do not send the full subscription URL.",
        ],
      },
    ],
  },
  "proxy-tool-downloads": {
    category: "Proxy tool downloads",
    title: "Proxy tool downloads",
    summary: "Choose a client for your operating system and download it.",
    sections: [
      {
        paragraphs: [
          "Choose a client for your operating system and processor type. Each “Download” link opens a third-party page; check the file name, version and device compatibility before downloading.",
        ],
      },
      {
        heading: "Windows",
        links: [
          { label: "Clash Verge · x64", url: "https://99data.qqx.me/f/vaC7/Clash.Verge_2.5.1_x64-setup.exe" },
          { label: "Clash Verge · x64 with bundled WebView2", url: "https://99data.qqx.me/f/LRh3/Clash.Verge_2.5.1_x64_fixed_webview2-setup.exe" },
          { label: "FlClash · Windows", url: "https://99data.qqx.me/s/G9hL" },
        ],
      },
      {
        heading: "macOS",
        links: [
          { label: "Clash Verge · Apple silicon", url: "https://99data.qqx.me/f/MdiJ/Clash.Verge_2.5.1_aarch64.dmg" },
          { label: "Clash Verge · Intel", url: "https://99data.qqx.me/f/apcn/Clash.Verge_2.5.1_x64.dmg" },
          { label: "FlClash · Apple silicon", url: "https://99data.qqx.me/s/RgT8" },
          { label: "FlClash · Intel", url: "https://99data.qqx.me/s/EeCv" },
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
};

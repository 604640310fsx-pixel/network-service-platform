# NSP 套餐订阅 v11（artifact r30）图标源文件

Source: Phosphor Icons core package **`@phosphor-icons/core` 2.1.1**, MIT license (`LICENSE-phosphor-MIT.txt`, copied unchanged from the package).

- npm: https://www.npmjs.com/package/@phosphor-icons/core/v/2.1.1
- Tarball the files were taken from: https://registry.npmjs.org/@phosphor-icons/core/-/core-2.1.1.tgz
- Repository: https://github.com/phosphor-icons/core

## Mapping

| 套餐 | as-used file | Original package file(s) |
|---|---|---|
| 纯净静态独享IP | `as-used/pure-ip_fingerprint-duotone.svg` | `assets/duotone/fingerprint-duotone.svg` (identical) |
| 真住宅宽带 | `as-used/residential_house-line-duotone.svg` | `assets/duotone/house-line-duotone.svg` (identical) |
| 独享双ISP静态原生 | `as-used/dual-isp_arrows-split-duotone-tint+bold-outline.svg` | **Composite:** the 20%-opacity tint path from `assets/duotone/arrows-split-duotone.svg` + the outline path from `assets/bold/arrows-split-bold.svg`, both unmodified, in one `<svg viewBox="0 0 256 256">` |
| 本地住宅原生静态IP | `as-used/local-isp_buildings-duotone.svg` | `assets/duotone/buildings-duotone.svg` (identical) |

`original/` holds the five untouched package files (including both arrows-split sources).

## How the artboards render them

- All files use `fill="currentColor"` with a 256 grid. The artboards set the colour per package via CSS `color`.
- Light theme: pure `#2f6f8f`, residential `#4a7d58`, dual-ISP `#5e58a0`, local ISP `#a05a72`.
- Dark theme: `#7db8d4`, `#8cc39a`, `#a8a2e4`, `#e098b4`.
- Size: desktop cards 26px, mobile cards 24px. The dual-ISP composite is drawn 2px larger (28px / 26px) with `margin: -1px`, so it keeps the same slot while matching the other three in visual weight.
- When inlining, the artboards only add `width`/`height`/`aria-hidden`, and drop Phosphor's transparent 256×256 bounding `<rect>` where present. The path data itself is unchanged.

## SHA-256

```
2390d01f9c704bd6ce61bc52c6ce20cb420132c308c58e389879d59796c7bc03  fingerprint-duotone.svg
c4a8e60acc0a98d65c01c210d9e6ac1cbc302d9e3df9ceffbbf9d9ff06f8dba4  house-line-duotone.svg
d6843f7a68d132f539effacbfc5151d6a506ee983f1a409ad98a868d8be14713  buildings-duotone.svg
be2fdc1ea346a6725ae906d2a3c40f09a3e40fc7027dd11660b697ba5236aad1  arrows-split-duotone.svg
aede1aa4790a00e2e7c859ac48ae9cfb00a107cf9598da88ef23bd794b7adef3  arrows-split-bold.svg
15de4ec2741b041400983043e0ae68b82d812f09d70b4367d2c122a84de3aa26  dual-isp composite (as used)
ddbe6082ec3cf979db47e5af549d2849c5d6182b3e005ef91ce1dbb9eb122f11  LICENSE-phosphor-MIT.txt
```

The hashes above identify the original exported files. In this repository only
the license line endings are normalized from CRLF to LF; the license wording is
unchanged. Its vendored SHA-256 is
`b5b1f1da112d18ea2147decfd48ddc1bf2b5aeb6c265381579340e95b15a2bb2`.

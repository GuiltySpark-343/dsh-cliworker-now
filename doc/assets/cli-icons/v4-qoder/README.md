# Qoder CLI 官方图标

2026-10-17，从 [Qoder 官方网站](https://qoder.com/) 下载页脚浅色主题使用的独立品牌符号，原样接入插件。未重新绘制或生成图像；品牌权利归原权利方。

## 来源与文件

- [官方原始 PNG](https://img.alicdn.com/imgextra/i4/O1CN012JUQmkuk4LH0cGga_!!6000000004828-2-tps-304-304.png)：304 × 304，带透明通道的索引色 PNG（P 模式），图形为 `#0F0D0C`。
- [qoder.png](qoder.png)：上述下载文件原件；与运行资源 `src/client/assets/qoder.png` 字节一致。
- SHA-256：`b0a3c6959fca7d07d5e840bd4fb23e5e8c1a9b5a528700d683476e2bfddd3900`。
- [manifest.json](manifest.json) 记录来源、透明度、光学参数和校验值。

## 主题与接入

- 复用 `BrandIcon` 的 PNG 资源与 `cwn-icon-mono` 规则；深色主题由 Harness 原生 `body[data-ds-dark-theme]` 状态应用 `filter: invert(1)`。
- 不新增主题开关、远程资源请求或额外暗色图片。
- 原图主体高 294 像素，占画布约 96.7%；光学缩放为 `0.8272`，使主体高约占图标槽的 80%。水平微移 `0.5442%`，保持视觉居中。
- [preview.html](preview.html)／[preview.png](preview.png) 显示 Qoder 与现有 ZCode、Antigravity 在 22、24、32px 图标槽和明暗背景下的对照。预览背景不属于 PNG。

## 实际验证

- 已核对官方网页的图像链接、原始 PNG 与运行副本 SHA-256。
- 将索引色 PNG 解码为 RGBA 后检查：四角 alpha 全为 0，完全透明像素 58,879 个；原始文件保持不变。
- 已使用 Tabbit 浏览器渲染并目视核对明暗主题和 22／24／32px：无不透明底板、裁切，轮廓可辨；预览图完整加载。
- 此目录只证明图标来源、透明度及独立预览；插件构建与真实 CLI 验收记录见本次 Qoder 集成的 OpenSpec 变更及 `doc/tasks.md`。

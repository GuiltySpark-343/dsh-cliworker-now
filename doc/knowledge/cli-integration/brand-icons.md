# 品牌图标接入

CLI 图标使用可追溯的本地品牌资源，通过统一 `BrandIcon` 适配主题和视觉尺寸。

## 1、机制与实施要点

- 运行图片放在 `src/client/assets`，由 `icons.tsx` 静态导入；页面显示不依赖远程图片请求。
- 为品牌资源记录来源、原件、校验值和处理方式。Qoder 图标记录还包含透明度检查、光学参数和独立预览，可作为后续接入模板。
- `BrandIcon` 使用统一槽位；通过 `optical` 中的缩放、平移补偿原图留白差异。图形实际大小与 PNG 画布尺寸分开处理。
- 单色图标复用主题规则；Kimi 使用独立明暗资源。需要按实际资源确定方案，不能对所有彩色图标直接反色。
- 至少目视核对明暗背景、常用小尺寸、透明边缘与裁切，并检查设置列表、选择器中的真实效果。

## 2、易错边界

图标文件存在不等于视觉验收通过；独立预览通过也不等于 Desktop 中所有入口都已验证。透明背景不能仅凭截图白底判断。安装插件界面名称仍保持 `CLI Worker / CLI Worker Now`，不随仓库分发名称改变。

## 3、源码与验证入口

- [统一图标组件](../../../src/client/icons.tsx)：`BrandIcon`、`icons`、`optical`。
- [Client 主题样式](../../../src/client/styles.ts)：`cwn-brand`、`cwn-icon-mono`。
- [Qoder 图标来源、主题与实际预览记录](../../assets/cli-icons/v4-qoder/README.md)。

## 4、关联笔记

[注册与能力声明](cli-registration.md) · [最小验收](integration-acceptance.md)

# EasySync

语言：简体中文 | [English](README.md)

EasySync 是一个尽量少配置、偏安全取向的 Obsidian 双向 OneDrive 同步插件。

它面向的是这类用户：

- 希望桌面端和移动端都能用同一套同步方案
- 更在意不误覆盖、不误删，而不是“越激进越快”
- 需要按需同步编辑器、外观、主题和插件设置
- 希望同步状态可见，出问题时有明确入口处理

EasySync 不是实时协作系统。它的目标是用尽量直接的方式，把跨设备同步做得更稳、更清楚。

## 使用前提

- Obsidian `1.11.4` 或更高版本
- 一个可用的 Microsoft / OneDrive 账号

## 快速开始

1. 安装并启用 **EasySync**
2. 打开插件设置，用 Microsoft 账号登录
3. 选择只同步仓库内容，或额外同步部分 Obsidian / 插件设置
4. 从设置页、Ribbon 图标或同步侧栏触发 **立即同步**
5. 如果有文件需要处理，打开同步侧栏按提示完成处理

## 可以同步什么

- 仓库中的 Markdown 笔记和附件
- 可选的 Obsidian 设置，例如编辑器、外观、主题、快捷键和插件设置
- 可选的社区插件代码与插件数据

## 为什么它比较保守

EasySync 的默认原则是安全优先：

- 同一文件两端都改了时，不会静默覆盖其中一侧
- 远端删除影响本地文件时，仍需要用户确认
- 某个文件无法安全同步时，其他文件可以继续，同步问题会留在侧栏中可见

## 当前边界

- 它不是 CRDT，也不是多人实时协作插件
- 一些跨设备改名或移动场景目前仍会走保守处理
- 移动端在慢网络下同步大文件可能较慢
- 文本自动合并已经有，但目前仍刻意保持保守

## OneDrive 与隐私

- EasySync 通过 Microsoft OAuth 登录 OneDrive
- 同步数据存放在插件对应的 OneDrive App Folder 区域
- 当前请求的权限为 `Files.ReadWrite.AppFolder` 和 `Files.Read`
- 只会访问完成登录与同步所需的 Microsoft OneDrive 接口
- 插件不会收集遥测或上传分析数据
- 诊断日志默认留在本地，除非你自己选择同步或导出

## 移动端支持

EasySync 同时面向桌面端和移动端 Obsidian。

当前开发默认把移动端兼容放在主线里处理。需要说明的是，在网络不稳定时，移动端同步大媒体文件通常会比桌面端更慢。

## 安装

通过官方审核后，可直接在 Obsidian 社区插件中安装 **EasySync**。

在此之前，也可以从 GitHub Releases 手动安装：

1. 下载 `main.js`、`manifest.json`、`styles.css`
2. 放入：

```text
<vault>/.obsidian/plugins/easy-sync/
```

3. 在 Obsidian 社区插件中启用 **EasySync**

## 源码可审阅说明

EasySync 的源码可公开查看和审阅，但不是开源授权项目。

当前可审阅实现位于 [`src/`](src)，自动化测试位于 [`tests/`](tests)。

详细条款见 [LICENSE](LICENSE)。

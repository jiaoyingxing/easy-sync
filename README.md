# 易同步（EasySync）

<p align="center">
  <a href="https://github.com/jiaoyingxing/easy-sync/releases">
    <img alt="Release downloads" src="https://img.shields.io/github/downloads/jiaoyingxing/easy-sync/total.svg?style=flat-square&label=Release%20downloads" />
  </a>
  <a href="https://github.com/jiaoyingxing/easy-sync/releases">
    <img alt="Latest release" src="https://img.shields.io/github/v/release/jiaoyingxing/easy-sync?style=flat-square&label=Latest%20release" />
  </a>
  <a href="./README.md">
    <img alt="CN 中文版" src="https://img.shields.io/badge/CN-%E4%B8%AD%E6%96%87%E7%89%88-d32f2f?style=flat-square" />
  </a>
  <a href="./README-en.md">
    <img alt="EN English" src="https://img.shields.io/badge/EN-English-2f6fed?style=flat-square" />
  </a>
</p>

<p align="center">
  <strong>阅读语言：</strong> <strong>简体中文</strong> · <a href="./README-en.md"><strong>English</strong></a>
</p>

EasySync 让你在电脑、手机和平板之间轻松同步Obsidian的笔记和附件。主题、快捷键、插件等内容可按需开启。安装插件后，登录OneDrive即可开始使用，2分钟完成部署。

- 安全可控：安全的变更可自动处理；冲突支持逐行比较，由你决定。

- 全程透明：同步状态、进度和历史在独立侧栏可见。

- 同步自由：自动同步，以及编辑器设置、外观、主题、快捷键和插件等范围可分别控制。

- 支持 Windows、macOS、Linux、iOS 和 Android，启动与同步速度都非常快。

## 1. 安装与首次配置

### 1.1 安装插件

在 Obsidian 中打开：

**设置 → 第三方插件 → 浏览 → 搜索 EasySync → 安装并启用**

需要 Obsidian `1.11.4` 或更高版本。

也可以从 [GitHub Releases](https://github.com/jiaoyingxing/easy-sync/releases) 手动安装：下载 `main.js`、`manifest.json` 和 `styles.css`，放入：
```text
<你的仓库>/.obsidian/plugins/easy-sync/
```
然后在 Obsidian 中启用插件。

### 1.2 准备本地仓库

> 使用 EasySync 时，不要把同一个 Obsidian 仓库直接放进 OneDrive、iCloud Drive、Dropbox、Syncthing 等其他同步工具管理的目录。

如果 EasySync 和另一个同步工具同时修改同一批文件，可能产生冲突副本、重复上传、删除回流或错误的同步判断。

建议：

- 把 Obsidian 仓库放在普通本地目录；
- 只让 EasySync 管理这个仓库的跨设备同步；
- 首次使用前为重要仓库保留一份独立备份。

### 1.3 登录 OneDrive

打开：

**Obsidian 设置 → EasySync → 登录 OneDrive**

完成 Microsoft 登录后，按页面提示返回 Obsidian。

### 1.4 在所有设备使用相同的仓库名

EasySync 根据仓库名区分云端同步空间。

例如，电脑上的仓库叫：
```text
我的笔记
```
手机上也应创建或打开名为“我的笔记”的仓库。不同名称会被视为不同的同步空间。

### 1.5 完成第一次同步

建议先在内容最完整的设备上点击“立即同步”，确认文件上传完成，再在其他设备上同步。

如果新设备还没有内容：

1. 创建一个同名空仓库；
2. 安装并登录 EasySync；
3. 点击“立即同步”；
4. 等待云端文件下载完成。

首次同步需要扫描、计算文件指纹并建立共同基线。文件较多或网络较慢时，耗时会明显长于后续同步。

## 2. 推荐配置

EasySync 的基础同步无需额外配置：仓库中的笔记和附件默认参与同步。

其他选项可以按需要开启：

| 设置 | 建议 |
| --- | --- |
| 同步范围 | 编辑器设置、外观、主题、快捷键、核心插件和社区插件等内容均可独立控制 |
| 社区插件 | 插件代码与启用列表由“社区插件”控制；各插件的 `data.json` 由“社区插件数据”单独控制 |
| EasySync 自同步 | 默认关闭；需要把 EasySync 更新同步到其他设备时再开启 |
| 自动同步 | 按设定间隔运行；关闭后仍可手动点击“立即同步” |
| 合并不重叠的文本修改 | 默认开启；无法证明安全时仍会保留冲突 |
| 将远端删除同步到本地 | 默认关闭；建议熟悉删除规则后再决定是否开启 |
| 诊断日志 | 日常可以关闭；排查同步问题时开启并生成诊断报告 |

所有设置只影响当前仓库，不会自动改变其他仓库的配置。

## 3. OneDrive 中的数据与权限

### 3.1 云端文件在哪里

EasySync 把每个仓库分别存放在 OneDrive 的应用目录中：

```text
应用/EasySync/vaults/<仓库名>/files/<你的文件路径>
```

例如：

```text
应用/EasySync/vaults/我的笔记/files/项目/计划.md
```

`files` 目录对应仓库中参与同步的文件。你可以通过 OneDrive 网页版或客户端查看这些云端副本。

同级的 `.easy-sync` 目录保存同步状态，请不要手动修改、移动或删除其中的文件。

> OneDrive 中的这些文件是 EasySync 管理的云端副本，不代表应该把本地 Obsidian 仓库直接移动到 OneDrive 同步目录。

### 3.2 数据如何传输

同步文件保存在你自己的 OneDrive 账户中。EasySync 直接连接 Microsoft 登录和 Microsoft Graph，不使用第三方中转服务器。

当前 Microsoft 授权包括：

- `Files.ReadWrite.AppFolder`：读写 EasySync 的 OneDrive 应用目录；
- `Files.Read`：完成文件读取和下载；
- 基本身份与离线登录权限：确认当前账号并维持登录状态。

EasySync 的同步路径限制在自己的应用目录：

```text
应用/EasySync/
```

插件不包含遥测、广告或用户行为分析。诊断日志默认保存在本地插件目录；诊断报告只有在你主动生成时才会写入仓库。

源码公开在 GitHub，供用户审查。

### 3.3 回收站与备份边界

如果 OneDrive 中的文件被删除，可以根据你的 OneDrive 账户策略检查回收站。回收站和同步记录都不能替代独立备份；重要内容仍建议定期保存到不受 EasySync 或其他同步工具管理的位置。

## 4. EasySync 能做什么

- 双向同步 Markdown、图片、音频、PDF 和其他仓库文件；
- 按哈希值判断文件变化，不只依赖修改时间；
- 上传前重新确认文件内容；如果扫描后文件又被编辑，本轮会延后该文件，不上传扫描时的旧内容；
- 下载替换本地文件前记录可恢复状态；同步中断时优先恢复原文件，若期间出现较新的本地版本则保留并重新判断；
- 远端删除默认留待确认；只有本地自共同基线后未修改且你开启相应自动处理时，才会自动同步到本地；
- 自动合并基于同一可靠版本、修改位置互不重叠的文本；
- 为无法安全处理的文本展示逐行差异；
- 为图片、PDF 等二进制冲突展示两端大小和修改时间；
- 在侧栏持续展示同步状态、进度、冲突和待处理项目；
- 支持连续处理多个冲突或待决策项目；
- 大文件使用分片上传；

## 5. 冲突如何处理

EasySync 会记录文件上一次成功同步的内容，并分别判断本地和远端发生了什么变化。

以下情况可以自动处理：

- 只有一端修改；
- 两端内容实际完全一致；
- 两端修改同一份文本，但修改位置互不重叠；
- 远端已删除、本地自共同基线后未修改，并且你已授权相应处理方式。

以下情况通常需要人工决定：

- 两端修改了同一行或相互重叠的内容；
- 没有可靠的共同版本；
- 图片、PDF、压缩包等二进制文件同时变化；
- Obsidian 管理的配置文件在两端发生冲突；
- 文件在计划生成后又被继续编辑；
- 当前账号、仓库范围或远端版本已经变化。

EasySync 不会因为某个文件“看起来更新”就直接覆盖另一端。

## 6. 使用边界

EasySync 是跨设备文件同步工具，不是多人实时协作系统。

请注意：

- 不要在多个设备上同时编辑同一个文件；
- 不要让 EasySync 与其他同步工具同时管理同一个本地仓库；
- 文件移动或重命名目前可能在另一端表现为“新增文件 + 原文件待删除”；
- 第一次同步、大量小文件或大文件传输需要更多时间；
- 自动处理只在安全条件完整时执行，条件不足会停止或转为人工处理；
- 同步不能代替独立备份，重要资料仍建议定期备份。

## 7. 遇到问题

先在 EasySync 设置中生成“诊断报告”。

提交问题时建议附上完整的 EasySync 诊断报告。

问题反馈：[GitHub Issues](https://github.com/jiaoyingxing/easy-sync/issues)

## 8. 许可

EasySync 采用 [MIT License](LICENSE) 开源。

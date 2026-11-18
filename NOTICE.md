# 原创与来源声明 · Credits and provenance

本分支由 SchallyHsu 维护，整合工作使用了 Codex 辅助开发。以下记录对应 2026-11-18 提交的整合版。

| 部分 | 作者与来源 | 本分支的工作 |
| --- | --- | --- |
| NeoRead 阅读器 | cynicalight 和 NeoRead 贡献者，基于 [NeoRead 提交 5ebe4ca](https://github.com/cynicalight/NeoRead/tree/5ebe4caf10090259e3a4d4c0757be0278bd43e3e) | 沿用 EPUB/PDF 阅读器、书库、Pi 模型连接和桌面应用，在现有侧栏、设置和服务端接入下列功能。 |
| Agent 与原生项目适配 | Zotero MCP 贡献者的 [v0.15.2 插件源码](https://github.com/54yyyu/zotero-mcp/tree/dfec70c8b772e697476e0b42c1264441cf518686/plugin)，经 SchallyHsu 的 [Zotero Agent 中文版 457042a](https://github.com/SchallyHsu/zotero-agent-zh-CN/tree/457042a4b6f4767b37e314ef2b843d4f8e44f755) 引入 | 复用 ACP 会话、桥接和原生项目归档代码，为 NeoRead 新增 worker、Windows 进程适配和运行状态反馈。[组件声明](apps/agent/native/zotero/NOTICE.md) |
| NeoRead 整合改动 | SchallyHsu 维护的本分支 | 接入四种原生 Agent，保存项目与会话绑定；实现适用于 NeoRead 书库的 WebDAV 文件传输、聊天合并和异机续聊，并提供设置界面、测试和[双机配置说明](docs/native-agents-webdav.zh-CN.md)。 |

基线提交中未发现覆盖整个 NeoRead 仓库的许可证。NeoRead 原作的权利归相应权利人，各第三方组件保留各自的声明。[NeoRead 第三方来源](docs/sources.md)

引入的 Zotero 插件代码沿用 **AGPL-3.0-or-later**。许可文本随这部分源码提供。[插件许可证](apps/agent/native/zotero/LICENSE) · [原插件修改与许可说明](https://github.com/SchallyHsu/zotero-agent-zh-CN/blob/457042a4b6f4767b37e314ef2b843d4f8e44f755/NOTICE.md)

## English

cynicalight and the NeoRead contributors created the original reader. The Zotero MCP contributors created the original plugin. SchallyHsu maintains the Chinese plugin derivative and this unofficial NeoRead integration, developed with assistance from Codex. This fork adds the reader-side native agent host and settings, project bindings, and WebDAV exchange of documents and conversations. The imported plugin code retains its AGPL-3.0-or-later terms. The referenced NeoRead revision includes component-specific notices and provides no repository-wide license.

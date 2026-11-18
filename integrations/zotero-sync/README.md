# Zotero 与 NeoRead 同步

在一台 Windows 桌面电脑的 Zotero 安装本扩展，同时运行该电脑上的 NeoRead 整合版及 Zotero Agent 简体中文版。Zotero 附件同步、Zotero Agent 聊天同步和 NeoRead 跨设备同步应使用同一 HTTPS WebDAV 目录和用户名。扩展每两分钟检查一次，两款桌面应用都打开时交换更新。其他桌面设备通过各自的同步功能接收内容；每个 WebDAV 账号只需要一台电脑安装桥接扩展。

- **文档**　对照个人 Zotero 文库与 NeoRead 的 PDF、EPUB，按内容哈希去重。NeoRead 中新增的文件通过 Zotero 的附件接口保存到个人文库，移动设备照常通过 Zotero 同步。Zotero 中新增的本地文件进入 NeoRead。第一次需要迁入已有的题录、分类、笔记和批注时，使用 NeoRead 的 Zotero 导入功能。后续跨应用交换的是原文件和新文档标题。
- **主机空间**　扩展核对 Zotero 原文件和 WebDAV 属性里的 MD5，并记录压缩包和属性文件的 ETag。支持附件索引的 NeoRead 电脑直接使用已有的 Zotero ZIP，下载后核验 SHA-256。索引失效且本机持有原件时，NeoRead 使用自己的原文件副本。之前已经上传的副本保持可用。其他 NeoRead 电脑需要包含本目录对应服务器代码的整合版，才能读取只有 Zotero ZIP 的文档。
- **聊天**　Zotero Agent 的按论文会话与 NeoRead 对应文档交换已完成的文字问答。保留原有 WebDAV 聊天记录，使用强 ETag 避免覆盖并发写入。助手的工具事件、思考过程和本机登录信息继续由原客户端管理。未关联论文的聊天可以在移动阅读页查看。Zotero Agent 历史记录只含会话级时间，导入 NeoRead 时按原问答顺序排列。
- **手机和平板**　用已配置的 Zotero 打开论文。连入家中网络或 VPN 后，用浏览器打开 WebDAV 目录下的 `zotero-agent-chat/read.html`，用同一 WebDAV 账号查看、搜索聊天。此页面直接从该主机读取文字问答，没有外部资源。手机版页面当前提供只读访问。
- **保留行为**　删除和回收站操作在各自的应用中处理。原文件的内容变更可作为新版本进入另一款应用。跨应用的持续批注编辑、翻译和阅读进度尚未实现。个人库中只有条目、设备或主机上缺失原件的附件，需先在 Zotero 找回原文件。

## 安装包

在本目录执行 `python build.py` 生成 XPI。在 Zotero 的工具菜单打开插件管理器，通过齿轮菜单选择「从文件安装」。状态和去重索引保存在该桌面 Zotero 配置目录的 `neoread-bridge-*.json`。

本扩展由 SchallyHsu 的整合项目提供，沿用仓库许可证。NeoRead 阅读器原作者为 cynicalight 和上游贡献者。Zotero Agent 的聊天格式来自 SchallyHsu/zotero-agent-zh-CN 及其上游贡献者。

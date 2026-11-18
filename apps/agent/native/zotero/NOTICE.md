# Zotero Agent component attribution

The ACP client, session handling and native project helpers in this directory come from SchallyHsu’s Chinese edition of Zotero Agent. The original plugin was developed by the Zotero MCP contributors. [Chinese edition at 457042a](https://github.com/SchallyHsu/zotero-agent-zh-CN/tree/457042a4b6f4767b37e314ef2b843d4f8e44f755) · [Original v0.15.2 plugin](https://github.com/54yyyu/zotero-mcp/tree/dfec70c8b772e697476e0b42c1264441cf518686/plugin)

On 2026-11-18 the SchallyHsu integration fork adapted the plugin’s test Node process adapter for the NeoRead worker in `node-spawner.ts`, including handling Windows npm command wrappers. The `agent/`, `helpers/` and `types.ts` sources were copied from the Chinese edition. The adjacent NeoRead worker hosts these components in the reading sidebar.

These plugin sources and the adaptation retain the **GNU Affero General Public License, version 3 or later**. [License text](LICENSE) · [Source modification notice](https://github.com/SchallyHsu/zotero-agent-zh-CN/blob/457042a4b6f4767b37e314ef2b843d4f8e44f755/NOTICE.md)

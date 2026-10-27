# HanaMesh Registry

Public intake list for plugins that appear in the HanaMesh catalog. One installable plugin = one file = one Hana.
HanaMesh 目录的公开收录清单。一个可安装的插件对应一个文件，也对应一个 Hana。

## Submit a plugin / 提交插件

1. Fork this repository and add **one** file `plugins/<file>.json`. The `id` is the npm package name (agent-only plugins: `<repository owner>/<name>`). The file name is the `id` with the first `/` replaced by `__`, for example `@acme/widget` → `plugins/@acme__widget.json`.
2. The file must match [`schema/plugin.schema.json`](schema/plugin.schema.json). Do not fill in `review`; the reviewer writes it.
3. Run the checks locally (Node 24): `npm install && node tools/check-entry.mjs plugins/<file>.json`.
4. Open a pull request. One PR changes one entry file.

一个 PR 只新增或修改一个条目文件。不要填写 `review` 字段，它由审核方写入。

A daily review pass checks every open PR. What it checks, what the labels mean and how delisting works: [REVIEW.md](REVIEW.md).

## Entry example / 条目示例

```json
{
  "id": "@acme/widget",
  "name": "Widget",
  "repository": "https://github.com/acme/widget",
  "npm": "@acme/widget",
  "version": "1.0.0",
  "channels": ["dsh", "hanamesh-client"],
  "categories": ["tools"],
  "description": { "en": "What it does.", "zh": "它做什么。" },
  "publisher": { "name": "Acme", "url": "https://github.com/acme" },
  "sourceUrl": "https://github.com/acme/widget#readme",
  "status": "listed"
}
```

Plugins installed through Claude or Codex marketplaces add `"claude"`/`"codex"` to `channels` and one `agentPlugins` item per channel:

```json
"agentPlugins": [
  { "channel": "claude", "marketplaceRepository": "acme/market", "ref": "<40-hex commit>", "marketplaceUrl": "https://github.com/acme/market", "pluginName": "widget" }
]
```

## Migration notes / 迁移说明

The first entries were migrated from HanaMesh's previous built-in list. `hanamesh-app-vibe-trading` will be handled in the next phase.
首批条目由 HanaMesh 原内置清单迁入；`hanamesh-app-vibe-trading` 下一阶段处理。

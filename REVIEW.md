# Review rules / 审核规则

Rules version: **1**. These rules are the public copy of the reviewer's rule set; the two are kept in sync.
规则版本 **1**。本文是审核方规则的公开版本，两者保持一致。

Open source is **not** required. What changes is the label: entries whose source can be verified are shown as "Source verified", everything else as "Unverified".
不强制开源，只影响标签：能核验源码的显示为「源码已核验」，其余显示为「未核验」。

## Basic checks / 基础校对

Run on every PR by `tools/check-entry.mjs`. Network access goes only to `registry.npmjs.org` and `raw.githubusercontent.com`; redirects are not followed and responses over 2 MB are refused (both count as "unreachable").

| Rule | Check | If it fails |
|---|---|---|
| R1 | One PR changes one file, `plugins/<file>.json` (checked by the reviewer from the PR file list); the entry matches the schema (strict semver `version`); file name equals the `id` (first `/` → `__`); `id` not used by another file (case-insensitive) | Closed with the reason |
| R2 | `npm@version` exists on the public npm registry; the returned name and version equal the entry exactly (case-sensitive, no trimming) | Closed; npm unreachable → owner |
| R3 | `npm` not already listed. On an existing entry, anything other than a forward `version`/`latestVersion` change | Closed / sent to the owner (also when a verified newcomer meets an unverified holder of the same npm name) |
| R4 | `channels` is valid. `dsh` and `hanamesh-client` need `npm`; `claude`/`codex` need an `agentPlugins` item whose `marketplaceUrl` is `https://github.com/<marketplaceRepository>` and whose plugin exists in that marketplace at the given commit | Closed / sent to the owner when the marketplace cannot be read, the plugin is missing, or its source does not match. In this phase every new or changed Claude/Codex channel is also confirmed by the owner. |
| R5 | Repository check (decides the label, see below) | Agent-only entries that contradict their marketplace, or use an archive source, are closed |
| R6 | npm `preinstall` / `install` / `postinstall` scripts | Not rejected; sent to the owner |
| R7 | `review` written by the author | Ignored |
| R8 | `status` changed (`listed` ↔ `delisted`) | Sent to the owner |
| R9 | New entries: `id` equals the npm name (agent-only: starts with the repository owner); no reserved HanaMesh namespace or category; `publisher.name` names the repository owner or npm scope; `sourceUrl` on the repository or npm package page (unverified entries: the npm package page); `publisher.url` is the repository owner on GitHub | Sent to the owner |

Deleting an entry file is not how delisting works; such PRs are sent to the owner.
Anything else the reviewer is not sure about goes to the owner instead of being merged.
其他拿不准的情况一律交给 owner，不自动合并。

Each run also re-checks the npm metadata of listed entries.

## Labels / 标签

| Label | Shown as | How it is decided |
|---|---|---|
| `source-verified` | Source verified · 源码已核验 | The npm package's `repository` points at the entry `repository`, **and** that repository's root `package.json` has `name` equal to the package name. Agent-only entries (no npm): every declared marketplace lists the plugin, and its source is the entry `repository`, which must be the marketplace repository itself or a repository with the same GitHub owner. Archive sources are never verified. |
| `unverified` | Unverified · 未核验 | Everything else. The repository link is not shown or stored. |
| `partial-source`, `closed-source-reviewed`, `closed-source-publisher-verified`, `package-reviewed` | Unverified · 未核验 | Reserved, assigned manually in later phases. |

- Only `source-verified` entries keep their GitHub repository. An unverified entry is indexed by its npm package only.
- Agent-only entries must be `source-verified`, otherwise they are not listed.
- Claiming a Hana needs a public GitHub repository on record, so unverified entries cannot be claimed until the two-way match is fixed and the entry is re-reviewed.

只有「源码已核验」的条目保存 GitHub 仓库；未核验的条目只按 npm 包收录，也不能认领。补齐双向对应、复核通过后即可认领。

## Delisting / 下架

A delisting is a PR that sets `"status": "delisted"` and a `delistReason`. After merge the entry is hidden from the catalog and search; its detail page shows "Delisted" without install links. Points already earned and the points history are kept; new usage stops scoring.
下架即提 PR 把 `status` 改为 `delisted` 并填写 `delistReason`。合并后条目从目录和搜索中隐藏，已得积分和积分历史保留，之后的使用不再计分。

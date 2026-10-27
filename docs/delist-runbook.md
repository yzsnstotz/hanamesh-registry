# Delist runbook / 下架运营手册

Phase 1: mark + stop scoring. Earned points, frozen allocations and on-chain parts are not touched (the ledger is append-only).
本期只做「标记 + 停止计分」，已有积分、已冻结的分配、已上链部分都不动。

1. **PR.** Open a PR that changes the entry to `"status": "delisted"` and fills `delistReason`. The reviewer escalates every status change (R8); the owner approves the merge.
   提 PR，把条目改为 `status: delisted` 并填写 `delistReason`。状态变更一律升级给 owner，由 owner 批准合并。
2. **Stop scoring.** After merge and the next indexer run, an operator looks up the entry's `hanaId` and sets scoring off:
   合并且 indexer 跑过之后，运营查到该条目的 `hanaId`，关闭计分：

   ```
   PUT /v1/custody/admin/reward-settings/hanas/:hanaId
   {"scoring": false}
   ```

3. **Verify.** On the website the entry is gone from the catalog and search; opening it by id shows "Delisted" without install links; a user's points history still lists earlier events; a new use event scores zero.
   核对：网站目录和搜索里已看不到该条目；按 ID 打开显示「已下架」且没有安装入口；用户积分历史仍在；新的使用事件为零分。

Relisting is the reverse PR (`"status": "listed"`, remove `delistReason`), also escalated, followed by `{"scoring": true}`. The Hana id does not change.
重新上架走反向 PR，同样升级给 owner，之后恢复 `{"scoring": true}`。Hana ID 不变。

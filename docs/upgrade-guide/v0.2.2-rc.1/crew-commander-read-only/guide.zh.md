---
kind: upgrade-guide
description: "Crew 指挥者不再提供通用 shell 或文件修改工具；实施改由 worker 执行，Git 写操作改用经批准的 crew_git 调用。"
---

# Crew 指挥者必须委派实施

[English](guide.md) | 中文

## 变更

此前，Crew 指挥者可以跳过所有委派角色，亲自用 `bash` 或 `pwsh`、`write`、`edit` 完成任务。新的 Crew 会话会移除这些能力。直接读取与回答仍然可用，所有实施动作则由 `worker` 执行。Git 操作改用 `crew_git`：写操作需要批准，每次调用都应用 Session 沙箱，并禁用仓库选择的命令钩子。已有会话保留其启动时的插件版本。

## 迁移

1. 升级后新建 Crew 会话。把每个文件修改、通用命令、构建、测试和部署派给 `worker`；指挥者不再为小任务提供直接实施的回退。
2. 指挥者负责的 Git 操作改用 `crew_git`。出现提示时，审查并批准每个写操作；批准不可用或被拒绝时，把该操作视为未执行。
3. 确认新会话的工具目录包含 `worker`、`planner`、`reviewer`、`read`、`crew_git`，且不包含 `bash`、`pwsh`、`write`、`edit`。
4. 读取被过滤的文件时预期看到存储字节。`crew_git` 会列出在目标仓库生效的 Git 配置键，并仅对本次调用把其中值指向程序的键覆盖为空——内容过滤器、合并驱动器、diff 助手、签名程序、编辑器、传输命令、凭据助手。仓库无法通过它写进自己 `.git/config` 的属性执行命令，且该配置与 index 都不被写入。因此在 `crew_git diff` 与 `crew_git show` 中，Git LFS 指针显示为指针文本，而本地 `git diff` 会还原内容。
5. 写操作保留仓库的过滤器。`checkout`、`commit`、`merge` 保留工作树所依赖的过滤器与合并驱动器；用户对写操作的批准就是把这一后果摆在面前。
6. 调用 `crew_git commit` 时传 `--message=`。它的 stdin 是关闭的且拒绝打开编辑器，因此不带消息的提交会立即失败而不是等待；不带 `--no-edit` 或 `-m` 的 `merge` 同理。

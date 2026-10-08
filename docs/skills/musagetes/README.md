# Musagetes

将本地音乐整理为可追溯、可恢复的专辑目录：发行匹配、标签修复、CUE 分轨、无损格式规范化与封面处理。执行规范从 [SKILL.md](../../../skills/musagetes/SKILL.md) 开始，采用项目统一的 [MIT License](../../../LICENSE)。版本记录在 SKILL.md 的 `metadata.version`。

## 安装

通过 skills CLI 安装：

```sh
npx skills add vizmoe/skills --skill musagetes
```

默认安装到当前项目；个人使用可加 `--global`，指定代理可加 `--agent codex`。更新使用 `npx skills update`。运行时安装目录保持只读，记录写入用户指定的音乐根目录内。

## 调用

在 Codex 输入 `$musagetes` 并指定实际音乐目录和范围，例如：

```text
$musagetes 只审计 /absolute/path/to/music，列出变更计划和阻断项。
$musagetes 整理 /absolute/path/to/music，本轮最多处理 10 张专辑。
$musagetes 只给 /absolute/path/to/album 的 CUE 分轨，保留原始文件。
$musagetes Organize my music folder at /absolute/path/to/music.
$musagetes Fix music tags in /absolute/path/to/music; preview the changes first.
```

以上是待替换的示例路径。根目录若为符号链接（例如指向外置卷的 Music），先确认其解析后的真实路径并以该路径调用。可以明确要求只预览、保留某些资料或调整处理数量；已有会话授权沿用。

冷门发行查证后仍无法可靠确定 COUNTRY 或受控 GENRE 时，允许缺失并在报告中说明原因，其它条件满足后可完成整理。已有可靠值继续保留，具体条件见[可靠信息缺失例外](../../../skills/musagetes/references/METADATA_WHITELIST.md#可靠信息缺失例外)。

## 运行条件与恢复

只读辅助脚本需要 Python 3.10+，仅使用标准库，调用时加 `-B`。音频、标签和解压工具按[当前操作所需能力](../../../skills/musagetes/references/AUDIO.md#工具)选用；不会自动安装。发行检索需要网络，外部服务不可用会在记录中说明。

[工具说明](../../../skills/musagetes/references/TOOLS.md)覆盖扫描、标签字段检查、封面尺寸、路径生成和历史检查。这些脚本只做预检；发行判断、完整音频校验和事务执行仍由调用代理按 skill 完成。

默认批大小、进度节奏、失败暂停及跨运行对账见[执行协议](../../../skills/musagetes/references/EXECUTION.md)。同一目录再次调用会核对历史快照与当前文件，而不是仅按目录名跳过。源文件、sidecar 和空目录的去向见[交付与清理](../../../skills/musagetes/references/DELIVERY.md)。

## 开发

修改技能、辅助脚本或领域规则时，阅读[维护指南](development.md)，其中链接行为用例、领域规则来源和专项测试。公共目录与安装检查见 [CONTRIBUTING.md](../../../CONTRIBUTING.md#本地验证)。

# Skills

可复用的 Agent Skills 集合，为智能代理提供完成具体任务所需的工作流程、参考资料和辅助工具。每个技能独立维护，按需安装；仓库随新的使用场景持续扩展。

技能采用 [Agent Skills 规范](https://agentskills.io/specification)，通过 [skills.sh CLI](https://skills.sh/docs/cli) 从本仓库安装。

## 安装与更新

在目标项目中交互选择技能：

```sh
npx skills add vizmoe/skills
```

查看可用技能、安装指定技能或更新已有安装：

```sh
npx skills add vizmoe/skills --list
npx skills add vizmoe/skills --skill musagetes
npx skills update
```

默认安装到当前项目；添加 `--global` 可供个人跨项目使用，添加 `--agent codex` 可指定代理。各技能的使用说明会列出额外运行条件。

## 技能目录

| 技能 | 能力 | 使用说明 |
| --- | --- | --- |
| [Musagetes](skills/musagetes/SKILL.md) | 本地音乐库整理、标签与封面检查、发行匹配、CUE 分轨 | [安装、调用与运行条件](docs/skills/musagetes/README.md) |
| [Quillbind](skills/quillbind/SKILL.md) | EPUB 构建、审计修复、轻小说采集与繁简转换 | [安装、调用与运行条件](docs/skills/quillbind/README.md) |

## 目录结构

```text
skills/<name>/         安装给代理的技能及其资源，以 SKILL.md 为入口
docs/skills/<name>/    面向使用者和维护者的技能说明
tests/catalog/         所有技能共用的规范、许可与安装测试
tests/skills/<name>/   技能行为和安装后的运行检查
tools/<name>/          可选的独立运行时，包含自身的构建、测试和文档
scripts/               仓库维护与校验脚本
```

同名目录用于关联一个技能的资源。简单技能只需必要的说明和资源；需要独立工具链时，再提供 `tools/<name>/` 运行时。测试、开发文档和本地运行数据保留在安装目录之外。

## 贡献与维护

新增技能、环境准备和验证方法见 [CONTRIBUTING.md](CONTRIBUTING.md)。公共校验与真实安装测试自动遍历 `skills/`；独立运行时保留自己的验证流程。

默认分支是发布源。更新经 PR 合并后即可通过 skills CLI 安装或更新。skills.sh 目录根据安装遥测发现技能，收录机制见[官方说明](https://skills.sh/docs/faq)。

## 许可证

本项目的技能、脚本、运行时和文档统一采用根目录的 [MIT License](LICENSE)。第三方材料保留各自的许可声明，例如 Quillbind 的[第三方声明](tools/quillbind/third-party/bili-novel-packer.txt)。

skills CLI 仅安装所选技能目录，因此每个技能附带根 `LICENSE` 的相同副本，用于独立分发时保留许可声明。根 `LICENSE` 是项目许可证的维护入口。

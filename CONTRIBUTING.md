# 贡献指南

本仓库接受能够独立发现、按需安装的 Agent Skills。先明确技能解决的任务、调用条件和运行依赖，再添加相应资源。技能格式以 [Agent Skills 规范](https://agentskills.io/specification) 为准，仓库目录职责见 [README](README.md#目录结构)。

## 新增或修改技能

1. 在 `skills/<name>/SKILL.md` 中定义名称、描述和工作流程。目录名与 frontmatter 的 `name` 一致；名称规则见规范。描述应帮助代理判断何时调用该技能。
2. 将执行所需资料放入技能目录，用相对链接从 `SKILL.md` 按需引用。`scripts/`、`references/`、`assets/` 是常用约定，也可按任务需要添加其他资源目录。仅创建实际需要的内容。
3. 在 frontmatter 声明 `license: MIT`，将根 `LICENSE` 复制到技能目录。校验器会检查声明与副本；附带的第三方材料保留其许可信息。
4. 在 `docs/skills/<name>/README.md` 提供面向使用者的调用示例、运行条件及开发指南入口，并在根 README 的技能表中添加一项。代理执行所需规则仍放在安装目录中。
5. 技能行为测试放在 `tests/skills/<name>/`。Python 测试使用 `test_*.py`，目录包含 `__init__.py`，由公共测试命令递归发现。复杂运行时放在 `tools/<name>/`，在该工作区维护依赖、测试和相应 CI，并在技能说明中链接配置方法。

新增技能无需修改公共校验器、安装测试中的名称列表或公共 CI 的测试入口。技能指令和资源必须能从独立安装目录使用；可选运行时通过文档声明的配置定位。

## 本地验证

从仓库根目录准备规范校验环境：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-skill.txt
python3 -B scripts/validate_skills.py
python3 -B -m unittest discover -s tests -v
```

Python 需支持当前技能和测试的运行条件；真实安装测试还需要 Node.js、npm 和网络。测试在临时项目中调用 skills CLI，不修改个人技能目录。依赖与校验工具版本以 [requirements-skill.txt](requirements-skill.txt) 和[安装测试工具](tests/support.py)为准。

公共检查覆盖所有技能的官方格式校验、项目许可副本、资源引用与隔离边界，并逐个验证真实安装文件与源目录一致。临时新增技能的安装用例覆盖目录扩展路径。行为测试使用隔离数据；仓库维护不构成操作用户真实文件库的授权。

改动具体技能时，继续执行其使用说明链接的专项验证；独立运行时的检查由各自的开发文档和 [.github/workflows](.github/workflows) 定义。技能安装与业务产物交付分别验证。

## 提交与发布

按 Issue → 工作分支 → 实现和验证 → PR → CI / review → 合并交付。一个独立问题对应一个 PR，记录验收结果与实际验证证据。

默认分支中的 `skills/<name>/` 是安装源。发布通过合并 Git 变更完成，用户使用 `npx skills add vizmoe/skills` 或 `npx skills update` 获取内容。安装目录随技能整体复制，测试、仓库开发资料、依赖缓存和运行产物应留在对应的外部目录。

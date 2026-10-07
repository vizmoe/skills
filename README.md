# Skills

可通过 [skills.sh](https://skills.sh/docs) 安装的 Agent Skills，目录遵循 [Agent Skills 规范](https://agentskills.io/specification)。

## 安装与更新

```sh
npx skills add vizmoe/skills --list
npx skills add vizmoe/skills --skill musagetes
npx skills add vizmoe/skills --skill quillbind
npx skills update
```

默认安装到当前项目。个人使用加 `--global`，指定代理加 `--agent codex`。

| Skill | 用途 | 运行条件 |
| --- | --- | --- |
| [musagetes](skills/musagetes/SKILL.md) | 本地音乐整理、发行匹配、标签与封面检查、CUE 分轨 | [使用与依赖](docs/musagetes.md) |
| [quillbind](skills/quillbind/SKILL.md) | Markdown／轻小说转 EPUB、EPUB 审计修复与繁简转换 | [Node 工作区配置](skills/quillbind/references/environment.md) |

Quillbind 安装后还需配置本仓库的 `tools/quillbind` 运行环境，并将 `QUILLBIND_ROOT` 指向该目录；详细步骤见上表。技能安装不会自动安装出版工具。

## 维护

`skills/` 只存放安装所需资源；`tests/`、`scripts/`、`docs/` 分别存放目录测试、校验和使用说明。`tools/quillbind/` 保留 EPUB 工具及其开发测试，验证流程见[开发说明](tools/quillbind/docs/development.md)。发布源是本仓库的默认分支。合并更新后，用户通过 skills CLI 安装或更新；skills.sh 目录根据安装遥测发现技能，出现时间由该服务决定，见[官方说明](https://skills.sh/docs/faq)。

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-skill.txt
python3 -B scripts/validate_skills.py
python3 -B -m unittest discover -s tests -v
python3 -B -m unittest discover -s tests/musagetes -v
```

安装测试需要 Node.js、npm 和网络，在临时项目中运行 skills CLI，不修改个人技能目录。Musagetes 使用其目录内的 [MIT License](skills/musagetes/LICENSE)。

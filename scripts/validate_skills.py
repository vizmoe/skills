#!/usr/bin/env python3
"""Validate the catalog with skills-ref, bundled-resource isolation and repository-wide Markdown links."""
from pathlib import Path
import argparse
import ast
import json
import re
import shutil
import subprocess
import sys
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
GENERATED = {".git", ".hg", ".svn", ".local", ".cache", ".venv", "__pycache__",
             "node_modules", "dist", "coverage", "test-results", "playwright-report", "ci-output"}
DEVELOPMENT = {"tests", "evals", "work", "AGENTS.md", "CONTRIBUTING.md"}
LINK = re.compile(r"\[[^\]\n]*\]\(([^)\n]+)\)")
JS_TOKEN = re.compile(r'''(?P<space>\s+)|(?P<comment>//[^\n]*|/\*.*?\*/)|(?P<string>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(?P<word>[\w$]+)|(?P<punct>.)''', re.S)
JS_REGEX = re.compile(r"/(?:\\.|[^/\\\n\[]|\[(?:\\.|[^\]\\\n])*\])*/[a-z]*")


def validate_license(skill: Path, project_license: Path, declared_license: str | None) -> None:
    if declared_license != "MIT":
        raise ValueError(f"Skill must declare the project's MIT license: {skill}")
    notice = skill / "LICENSE"
    if not notice.is_file() or notice.read_bytes() != project_license.read_bytes():
        raise ValueError(f"Bundle an exact copy of the project LICENSE: {skill}")


def discover_skills(root: Path) -> list[Path]:
    skills = sorted((root / "skills").iterdir())
    if not skills:
        raise ValueError("No skills found")
    for skill in skills:
        if skill.is_symlink() or not skill.is_dir() or not (skill / "SKILL.md").is_file():
            raise ValueError(f"Expected a local skill directory with SKILL.md: {skill}")
    return skills


def walk(directory: Path):
    """Repository files, skipping version-control, dependency, cache and build-output trees."""
    for entry in sorted(directory.iterdir()):
        if entry.name in GENERATED or entry.is_symlink():
            continue
        if entry.is_dir():
            yield from walk(entry)
        elif entry.is_file():
            yield entry


def prose(text: str) -> str:
    text = re.sub(r"(?ms)^\s*(```|~~~).*?^\s*\1\s*$", "", text)
    return re.sub(r"(`+).*?\1", "", text, flags=re.S)


def anchors(text: str) -> set[str]:
    found, result = {}, set()
    for heading in re.findall(r"(?m)^#{1,6}\s+(.+?)\s*#*\s*$", prose(text)):
        identifier = re.search(r"\{#([^}\s]+)\}\s*$", heading)
        if identifier:
            result.add(identifier.group(1))
            continue
        slug = re.sub(r"[^\w\s-]", "", heading.lower()).replace(" ", "-")
        count = found.get(slug, 0)
        found[slug] = count + 1
        result.add(f"{slug}-{count}" if count else slug)
    return result


def links(source: Path):
    """Repository-local link targets of one Markdown file, as (link, resolved target, fragment)."""
    for link in LINK.findall(prose(source.read_text(encoding="utf-8"))):
        url = urlsplit(link)
        if url.scheme or url.netloc:
            continue
        target = (source.parent / unquote(url.path)).resolve() if url.path else source.resolve()
        yield link, target, unquote(url.fragment)


def validate_anchor(source: Path, link: str, target: Path, fragment: str) -> None:
    if fragment and (target.suffix != ".md" or fragment not in anchors(target.read_text(encoding="utf-8"))):
        raise ValueError(f"Broken heading anchor: {source} -> {link}")


def validate_resources(skill: Path) -> None:
    """An installed skill must be self-contained, free of development files and fully reachable."""
    skill = skill.resolve()
    graph = {}
    for source in skill.rglob("*"):
        if source.name in GENERATED or (source.parent == skill and source.name in DEVELOPMENT):
            raise ValueError(f"Development or generated resource in installed skill: {source}")
        if source.is_symlink():
            raise ValueError(f"Linked runtime resource: {source}")
        if source.suffix != ".md" or not source.is_file():
            continue
        graph[source] = set()
        for link, target, fragment in links(source):
            if not target.is_relative_to(skill) or not target.is_file():
                raise ValueError(f"Missing or escaping resource: {source} -> {link}")
            validate_anchor(source, link, target, fragment)
            graph[source].add(target)
    reached = {skill / "SKILL.md"}
    pending = list(reached)
    while pending:
        for target in graph.get(pending.pop(), set()) - reached:
            reached.add(target)
            pending.append(target)
    for document in graph:
        if document not in reached:
            raise ValueError(f"Unreachable reference: {document}")
    # Scripts and data are often named inside fenced commands, so match mentions in the reachable text.
    mentions = "\n".join(document.read_text(encoding="utf-8") for document in sorted(graph))
    for resource in sorted(skill.rglob("*")):
        if not resource.is_file() or resource in reached or resource.name == "LICENSE":
            continue
        relative = resource.relative_to(skill).as_posix()
        if relative not in mentions and resource.name not in mentions:
            raise ValueError(f"Unreachable resource: {resource}")


def javascript_tokens(text: str) -> list[tuple[str, str]]:
    """Keep executable tokens, including template expressions, separate from literal data."""
    tokens = []

    def scan(position: int, expression: bool = False) -> int:
        depth = 0
        while position < len(text):
            token = JS_TOKEN.match(text, position)
            kind, value = token.lastgroup, token.group()
            position = token.end()
            if kind in {"space", "comment"}:
                continue
            if value == "}" and expression and depth == 0:
                return position
            if value == "`":
                tokens.append(("template", value))
                while position < len(text):
                    if text[position] == "\\":
                        position += 2
                    elif text[position] == "`":
                        position += 1
                        break
                    elif text.startswith("${", position):
                        tokens.append(("punct", "{"))
                        position = scan(position + 2, True)
                        tokens.append(("punct", "}"))
                    else:
                        position += 1
                tokens.append(("template", "`"))
                continue
            previous = tokens[-1][1] if tokens else ";"
            if value == "/" and previous in {"=", "(", "[", "{", ",", ":", ";", "!", "?", "&", "|", ">", "return", "throw", "case"}:
                literal = JS_REGEX.match(text, token.start())
                if literal:
                    tokens.append(("regex", literal.group()))
                    position = literal.end()
                    continue
            if value == "{":
                depth += 1
            elif value == "}":
                depth -= 1
            tokens.append((kind, value))
        return position

    scan(0)
    return tokens


def javascript_imports(source: Path):
    tokens = javascript_tokens(source.read_text(encoding="utf-8"))
    for index, (kind, value) in enumerate(tokens):
        if kind != "word" or value not in {"import", "export", "require"}:
            continue
        if index and tokens[index - 1][1] == "." and not (value == "require" and index > 1 and tokens[index - 2][1] == "module"):
            continue
        following = tokens[index + 1:]
        if not following or following[0][1] == ".":
            continue
        if value in {"import", "require"} and following[0][1] == "(":
            endings = {")", ","} if value == "import" else {")"}
            if len(following) < 3 or following[1][0] != "string" or following[2][1] not in endings:
                raise ValueError(f"Bundled imports require a string literal for static validation: {source}")
            yield value, ast.literal_eval(following[1][1])
        elif value == "import" and following[0][0] == "string":
            yield value, ast.literal_eval(following[0][1])
        elif value == "import" or (value == "export" and following[0][1] in {"{", "*"}):
            for offset, (next_kind, next_value) in enumerate(following[:-1]):
                if next_value == ";":
                    break
                if next_kind == "word" and next_value == "from" and following[offset + 1][0] == "string":
                    yield value, ast.literal_eval(following[offset + 1][1])
                    break


def python_module_exists(skill: Path, directory: Path, name: str) -> bool:
    target = directory.joinpath(*name.split("."))
    module = target.with_suffix(".py")
    return ((module.resolve().is_relative_to(skill) and module.is_file())
            or (target.resolve().is_relative_to(skill) and target.is_dir()))


def validate_dependencies(skill: Path) -> None:
    """A bundled script runs from the installed directory, so it may only use the standard
    library or another bundled file. Adding a third-party dependency is a deliberate change
    to this rule, not something a skill can introduce silently."""
    skill = skill.resolve()
    for source in sorted(skill.rglob("*.py")):
        roots = [source.parent]
        while (roots[-1] / "__init__.py").is_file() and roots[-1] != skill:
            roots.append(roots[-1].parent)
        for node in ast.walk(ast.parse(source.read_text(encoding="utf-8"), filename=str(source))):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                if node.level:
                    directory = source.parent
                    for _ in range(node.level - 1):
                        directory = directory.parent
                    if not python_module_exists(skill, directory, node.module or ""):
                        raise ValueError(f"Bundled script imports a missing or escaping file: {source} -> {'.' * node.level}{node.module or ''}")
                    continue
                names = [node.module or ""]
            else:
                continue
            for name in names:
                if name.split(".")[0] in sys.stdlib_module_names:
                    continue
                if any(python_module_exists(skill, directory, name) for directory in roots):
                    continue
                raise ValueError(f"Bundled script needs an external package: {source} -> {name}")
    for source in sorted(path for path in skill.rglob("*") if path.is_file() and path.suffix in {".js", ".cjs", ".mjs"}):
        for kind, specifier in javascript_imports(source):
            if specifier.startswith("node:"):
                continue
            if not specifier.startswith(("./", "../")):
                raise ValueError(f"Bundled script needs an external package: {source} -> {specifier}")
            relative = specifier if kind == "require" else unquote(urlsplit(specifier).path)
            target = source.parent / relative
            candidates = [target]
            if kind == "require":
                candidates.extend(Path(str(target) + suffix) for suffix in (".js", ".json", ".node"))
            if not any(path.resolve().is_relative_to(skill) and path.is_file() for path in candidates):
                raise ValueError(f"Bundled script imports a missing or escaping file: {source} -> {specifier}")


def validate_distribution(root: Path, skills: list[Path], files: list[Path]) -> None:
    """The skills CLI treats any discoverable SKILL.md as an installable unit; allow only the catalog's."""
    expected = {(skill / "SKILL.md").resolve() for skill in skills}
    for stray in sorted({f.resolve() for f in files if f.name == "SKILL.md"} - expected):
        raise ValueError(f"Installable SKILL.md outside the catalog's skill directories: {stray}")


def validate_documentation(root: Path, files: list[Path]) -> int:
    """Guides, contribution notes and runtime docs must not accumulate broken cross-references."""
    root = root.resolve()
    documents = [f for f in files if f.suffix == ".md"]
    for source in documents:
        for link, target, fragment in links(source):
            if not target.is_relative_to(root) or not target.exists():
                raise ValueError(f"Missing or escaping link target: {source} -> {link}")
            validate_anchor(source, link, target, fragment)
    return len(documents)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT, help="Catalog root (defaults to this checkout)")
    root = parser.parse_args().root.resolve()
    local = ROOT / ".venv/bin/skills-ref"
    validator = str(local) if local.is_file() else shutil.which("skills-ref")
    if not validator:
        raise SystemExit("Install requirements-skill.txt into .venv or provide skills-ref on PATH.")
    files = list(walk(root))
    skills = discover_skills(root)
    validate_distribution(root, skills, files)
    for skill in skills:
        subprocess.run([validator, "validate", str(skill)], check=True, timeout=30)
        validate_resources(skill)
        validate_dependencies(skill)
        properties = json.loads(subprocess.check_output(
            [validator, "read-properties", str(skill)], text=True, timeout=30,
        ))
        validate_license(skill, root / "LICENSE", properties.get("license"))
        print(f"Resource validation passed: {skill.name}")
    print(f"Repository link validation passed: {validate_documentation(root, files)} Markdown files")


if __name__ == "__main__":
    main()

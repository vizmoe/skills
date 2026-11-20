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
SKILL_ENTRYPOINT = "SKILL.md"
GENERATED = {".git", ".hg", ".svn", ".local", ".cache", ".scannerwork", ".venv", "__pycache__",
             "node_modules", "dist", "coverage", "test-results", "playwright-report", "ci-output"}
DEVELOPMENT = {"tests", "evals", "work", "AGENTS.md", "CONTRIBUTING.md"}
LINK = re.compile(r"\[[^\]\n]*\]\(([^)\n]+)\)")
HEADING_PREFIX = re.compile(r"^#{1,6}\s+")
JS_SPACE = re.compile(r"\s+")
JS_WORD = re.compile(r"[\w$]+")
JS_REGEX = re.compile(r"/(?:\\.|[^/\\\n\[]|\[(?:\\.|[^\]\\\n])*\])*/[a-z]*")
REGEX_PREDECESSORS = {"=", "(", "[", "{", ",", ":", ";", "!", "?", "&", "|", ">", "return", "throw", "case"}
SCRIPT_SUFFIXES = {".js", ".cjs", ".mjs", ".ts", ".cts", ".mts"}
TS_REMAP = {".js": ".ts", ".mjs": ".mts", ".cjs": ".cts"}


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
        if skill.is_symlink() or not skill.is_dir() or not (skill / SKILL_ENTRYPOINT).is_file():
            raise ValueError(f"Expected a local skill directory with {SKILL_ENTRYPOINT}: {skill}")
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


def _strip_inline_code(text: str) -> str:
    parts: list[str] = []
    position = 0
    length = len(text)
    while position < length:
        tick = text.find("`", position)
        if tick == -1:
            parts.append(text[position:])
            break
        parts.append(text[position:tick])
        end_tick = tick
        while end_tick < length and text[end_tick] == "`":
            end_tick += 1
        fence = text[tick:end_tick]
        close = text.find(fence, end_tick)
        if close == -1:
            parts.append(fence)
            position = end_tick
        else:
            position = close + len(fence)
    return "".join(parts)


def prose(text: str) -> str:
    text = re.sub(r"(?ms)^\s*(```|~~~).*?^\s*\1\s*$", "", text)
    return _strip_inline_code(text)


def _extract_headings(text: str):
    for line in prose(text).splitlines():
        match = HEADING_PREFIX.match(line)
        if not match:
            continue
        heading = line[match.end():].rstrip(" \t").rstrip("#").rstrip(" \t")
        if heading:
            yield heading


def anchors(text: str) -> set[str]:
    found, result = {}, set()
    for heading in _extract_headings(text):
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


def _collect_document_targets(skill: Path, source: Path) -> set[Path]:
    targets = set()
    for link, target, fragment in links(source):
        if not target.is_relative_to(skill) or not target.is_file():
            raise ValueError(f"Missing or escaping resource: {source} -> {link}")
        validate_anchor(source, link, target, fragment)
        targets.add(target)
    return targets


def _build_resource_graph(skill: Path) -> dict[Path, set[Path]]:
    graph: dict[Path, set[Path]] = {}
    for source in skill.rglob("*"):
        if source.name in GENERATED or (source.parent == skill and source.name in DEVELOPMENT):
            raise ValueError(f"Development or generated resource in installed skill: {source}")
        if source.is_symlink():
            raise ValueError(f"Linked runtime resource: {source}")
        if source.suffix == ".md" and source.is_file():
            graph[source] = _collect_document_targets(skill, source)
    return graph


def _reachable_documents(graph: dict[Path, set[Path]], entrypoint: Path) -> set[Path]:
    reached = {entrypoint}
    pending = [entrypoint]
    while pending:
        for target in graph.get(pending.pop(), set()) - reached:
            reached.add(target)
            pending.append(target)
    return reached


def _validate_resource_mentions(skill: Path, graph: dict[Path, set[Path]], reached: set[Path]) -> None:
    # Scripts and data are often named inside fenced commands, so match mentions in the reachable text.
    mentions = "\n".join(document.read_text(encoding="utf-8") for document in sorted(graph))
    for resource in sorted(skill.rglob("*")):
        if not resource.is_file() or resource in reached or resource.name == "LICENSE":
            continue
        relative = resource.relative_to(skill).as_posix()
        if relative not in mentions and resource.name not in mentions:
            raise ValueError(f"Unreachable resource: {resource}")


def validate_resources(skill: Path) -> None:
    """An installed skill must be self-contained, free of development files and fully reachable."""
    skill = skill.resolve()
    graph = _build_resource_graph(skill)
    reached = _reachable_documents(graph, skill / SKILL_ENTRYPOINT)
    for document in graph:
        if document not in reached:
            raise ValueError(f"Unreachable reference: {document}")
    _validate_resource_mentions(skill, graph, reached)


def _scan_js_comment(text: str, position: int) -> int | None:
    if text.startswith("//", position):
        newline = text.find("\n", position + 2)
        return len(text) if newline == -1 else newline
    if text.startswith("/*", position):
        close = text.find("*/", position + 2)
        return len(text) if close == -1 else close + 2
    return None


def _scan_js_quoted(text: str, position: int) -> int:
    quote = text[position]
    position += 1
    while position < len(text):
        char = text[position]
        if char == "\\":
            position += 2
        elif char == quote:
            return position + 1
        else:
            position += 1
    return position


def _next_js_token(text: str, position: int) -> tuple[str, str, int]:
    if space := JS_SPACE.match(text, position):
        return "space", space.group(), space.end()
    comment_end = _scan_js_comment(text, position)
    if comment_end is not None:
        return "comment", text[position:comment_end], comment_end
    if text[position] in {"'", '"'}:
        end = _scan_js_quoted(text, position)
        return "string", text[position:end], end
    if word := JS_WORD.match(text, position):
        return "word", word.group(), word.end()
    return "punct", text[position], position + 1


def _scan_js_template(text: str, position: int, tokens: list[tuple[str, str]]) -> int:
    tokens.append(("template", "`"))
    while position < len(text):
        if text[position] == "\\":
            position += 2
        elif text[position] == "`":
            position += 1
            break
        elif text.startswith("${", position):
            tokens.append(("punct", "{"))
            position = _scan_js_scope(text, position + 2, tokens, True)
            tokens.append(("punct", "}"))
        else:
            position += 1
    tokens.append(("template", "`"))
    return position


def _scan_js_regex(text: str, start: int, value: str, tokens: list[tuple[str, str]]) -> int | None:
    previous = tokens[-1][1] if tokens else ";"
    if value != "/" or previous not in REGEX_PREDECESSORS:
        return None
    literal = JS_REGEX.match(text, start)
    if not literal:
        return None
    tokens.append(("regex", literal.group()))
    return literal.end()


def _scan_js_scope(text: str, position: int, tokens: list[tuple[str, str]], expression: bool = False) -> int:
    depth = 0
    while position < len(text):
        start = position
        kind, value, position = _next_js_token(text, position)
        if kind in {"space", "comment"}:
            continue
        if value == "}" and expression and depth == 0:
            return position
        if value == "`":
            position = _scan_js_template(text, position, tokens)
            continue
        regex_end = _scan_js_regex(text, start, value, tokens)
        if regex_end is not None:
            position = regex_end
            continue
        depth += (value == "{") - (value == "}")
        tokens.append((kind, value))
    return position


def javascript_tokens(text: str) -> list[tuple[str, str]]:
    """Keep executable tokens, including template expressions, separate from literal data."""
    tokens: list[tuple[str, str]] = []
    _scan_js_scope(text, 0, tokens)
    return tokens


def _is_skipped_member_keyword(tokens: list[tuple[str, str]], index: int, value: str) -> bool:
    if not index or tokens[index - 1][1] != ".":
        return False
    return not (value == "require" and index > 1 and tokens[index - 2][1] == "module")


def _is_reexport(following: list[tuple[str, str]]) -> bool:
    if following[0][1] in {"{", "*"}:
        return True
    return following[0] == ("word", "type") and len(following) > 1 and following[1][1] in {"{", "*"}


def _find_from_specifier(following: list[tuple[str, str]]) -> str | None:
    for offset, (next_kind, next_value) in enumerate(following[:-1]):
        if next_value == ";":
            return None
        if next_kind == "word" and next_value == "from" and following[offset + 1][0] == "string":
            return ast.literal_eval(following[offset + 1][1])
    return None


def _extract_js_import(source: Path, value: str, following: list[tuple[str, str]]) -> str | None:
    if value in {"import", "require"} and following[0][1] == "(":
        endings = {")", ","} if value == "import" else {")"}
        if len(following) < 3 or following[1][0] != "string" or following[2][1] not in endings:
            raise ValueError(f"Bundled imports require a string literal for static validation: {source}")
        return ast.literal_eval(following[1][1])
    if value == "import" and following[0][0] == "string":
        return ast.literal_eval(following[0][1])
    if value == "import" or (value == "export" and _is_reexport(following)):
        return _find_from_specifier(following)
    return None


def javascript_imports(source: Path):
    tokens = javascript_tokens(source.read_text(encoding="utf-8"))
    for index, (kind, value) in enumerate(tokens):
        if kind != "word" or value not in {"import", "export", "require"}:
            continue
        if _is_skipped_member_keyword(tokens, index, value):
            continue
        following = tokens[index + 1:]
        if not following or following[0][1] == ".":
            continue
        specifier = _extract_js_import(source, value, following)
        if specifier is not None:
            yield value, specifier


def python_module_exists(skill: Path, directory: Path, name: str) -> bool:
    target = directory.joinpath(*name.split("."))
    module = target.with_suffix(".py")
    return ((module.resolve().is_relative_to(skill) and module.is_file())
            or (target.resolve().is_relative_to(skill) and target.is_dir()))


def _python_roots(skill: Path, source: Path) -> list[Path]:
    roots = [source.parent]
    while (roots[-1] / "__init__.py").is_file() and roots[-1] != skill:
        roots.append(roots[-1].parent)
    return roots


def _validate_python_relative_import(skill: Path, source: Path, node: ast.ImportFrom) -> None:
    directory = source.parent
    for _ in range(node.level - 1):
        directory = directory.parent
    if not python_module_exists(skill, directory, node.module or ""):
        raise ValueError(f"Bundled script imports a missing or escaping file: {source} -> {'.' * node.level}{node.module or ''}")


def _validate_python_names(skill: Path, source: Path, roots: list[Path], names: list[str]) -> None:
    for name in names:
        top = name.split(".")[0]
        if top in sys.stdlib_module_names:
            continue
        bundled_roots = [directory for directory in roots if python_module_exists(skill, directory, top)]
        if bundled_roots and not any(python_module_exists(skill, directory, name) for directory in bundled_roots):
            raise ValueError(f"Bundled script imports a missing or escaping file: {source} -> {name}")


def _validate_python_file(skill: Path, source: Path) -> None:
    roots = _python_roots(skill, source)
    for node in ast.walk(ast.parse(source.read_text(encoding="utf-8"), filename=str(source))):
        if isinstance(node, ast.Import):
            _validate_python_names(skill, source, roots, [alias.name for alias in node.names])
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                _validate_python_relative_import(skill, source, node)
            else:
                _validate_python_names(skill, source, roots, [node.module or ""])


def _js_import_candidates(source: Path, kind: str, specifier: str) -> list[Path]:
    relative = specifier if kind == "require" else unquote(urlsplit(specifier).path)
    target = source.parent / relative
    candidates = [target]
    if source.suffix in {".ts", ".cts", ".mts"} and target.suffix in TS_REMAP:
        candidates.append(target.with_suffix(TS_REMAP[target.suffix]))
    if kind == "require":
        candidates.extend(Path(str(target) + suffix) for suffix in (".ts", ".cts", ".js", ".cjs", ".json", ".node"))
    return candidates


def _validate_js_file(skill: Path, source: Path) -> None:
    for kind, specifier in javascript_imports(source):
        if not specifier.startswith(("./", "../")):
            continue
        candidates = _js_import_candidates(source, kind, specifier)
        if not any(path.resolve().is_relative_to(skill) and path.is_file() for path in candidates):
            raise ValueError(f"Bundled script imports a missing or escaping file: {source} -> {specifier}")


def validate_dependencies(skill: Path) -> None:
    """Bundled scripts may import standard-library or third-party packages, while any local
    or relative import must resolve to an existing file inside the skill directory."""
    skill = skill.resolve()
    for source in sorted(skill.rglob("*.py")):
        _validate_python_file(skill, source)
    for source in sorted(path for path in skill.rglob("*") if path.is_file() and path.suffix in SCRIPT_SUFFIXES):
        _validate_js_file(skill, source)


def validate_distribution(skills: list[Path], files: list[Path]) -> None:
    """The skills CLI treats any discoverable SKILL.md as an installable unit; allow only the catalog's."""
    expected = {(skill / SKILL_ENTRYPOINT).resolve() for skill in skills}
    for stray in sorted({f.resolve() for f in files if f.name == SKILL_ENTRYPOINT} - expected):
        raise ValueError(f"Installable {SKILL_ENTRYPOINT} outside the catalog's skill directories: {stray}")


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
    validate_distribution(skills, files)
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

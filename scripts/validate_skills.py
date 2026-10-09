#!/usr/bin/env python3
"""Validate the catalog with skills-ref, bundled-resource isolation and repository-wide Markdown links."""
from pathlib import Path
import argparse
import json
import re
import shutil
import subprocess
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
GENERATED = {".git", ".hg", ".svn", ".local", ".cache", ".venv", "__pycache__",
             "node_modules", "dist", "coverage", "test-results", "playwright-report", "ci-output"}
DEVELOPMENT = {"tests", "evals", "work", "AGENTS.md", "CONTRIBUTING.md"}
LINK = re.compile(r"\[[^\]\n]*\]\(([^)\n]+)\)")


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
        properties = json.loads(subprocess.check_output(
            [validator, "read-properties", str(skill)], text=True, timeout=30,
        ))
        validate_license(skill, root / "LICENSE", properties.get("license"))
        print(f"Resource validation passed: {skill.name}")
    print(f"Repository link validation passed: {validate_documentation(root, files)} Markdown files")


if __name__ == "__main__":
    main()

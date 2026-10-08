#!/usr/bin/env python3
"""Validate the catalog with skills-ref and check self-contained Markdown resources."""
from pathlib import Path
import argparse
import json
import re
import shutil
import subprocess
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]


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


def prose(text: str) -> str:
    text = re.sub(r"(?ms)^\s*(```|~~~).*?^\s*\1\s*$", "", text)
    return re.sub(r"(`+).*?\1", "", text, flags=re.S)


def anchors(text: str) -> set[str]:
    found, result = {}, set()
    for heading in re.findall(r"(?m)^#{1,6}\s+(.+?)\s*#*\s*$", prose(text)):
        slug = re.sub(r"[^\w\s-]", "", heading.lower()).replace(" ", "-")
        count = found.get(slug, 0)
        found[slug] = count + 1
        result.add(f"{slug}-{count}" if count else slug)
    return result


def validate_resources(skill: Path) -> None:
    skill = skill.resolve()
    development = {"tests", "evals", "work", "AGENTS.md", "CONTRIBUTING.md"}
    generated = {".git", ".hg", ".svn", ".local", ".cache", ".venv", "__pycache__",
                 "node_modules", "dist", "coverage", "test-results", "playwright-report", "ci-output"}
    graph = {}
    for source in skill.rglob("*"):
        if source.name in generated or (source.parent == skill and source.name in development):
            raise ValueError(f"Development or generated resource in installed skill: {source}")
        if source.is_symlink():
            raise ValueError(f"Linked runtime resource: {source}")
        if source.suffix != ".md" or not source.is_file():
            continue
        graph[source] = set()
        for link in re.findall(r"\[[^\]\n]*\]\(([^)\n]+)\)", prose(source.read_text(encoding="utf-8"))):
            url = urlsplit(link)
            if url.scheme or url.netloc:
                continue
            target = (source.parent / unquote(url.path)).resolve() if url.path else source
            if not target.is_relative_to(skill) or not target.is_file():
                raise ValueError(f"Missing or escaping resource: {source} -> {link}")
            if url.fragment and (target.suffix != ".md" or unquote(url.fragment) not in anchors(target.read_text(encoding="utf-8"))):
                raise ValueError(f"Broken heading anchor: {source} -> {link}")
            graph[source].add(target)
    reached = {skill / "SKILL.md"}
    pending = list(reached)
    while pending:
        for target in graph.get(pending.pop(), set()) - reached:
            reached.add(target)
            pending.append(target)
    for reference in (skill / "references").rglob("*.md"):
        if reference not in reached:
            raise ValueError(f"Unreachable reference: {reference}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT, help="Catalog root (defaults to this checkout)")
    root = parser.parse_args().root.resolve()
    local = ROOT / ".venv/bin/skills-ref"
    validator = str(local) if local.is_file() else shutil.which("skills-ref")
    if not validator:
        raise SystemExit("Install requirements-skill.txt into .venv or provide skills-ref on PATH.")
    for skill in discover_skills(root):
        subprocess.run([validator, "validate", str(skill)], check=True, timeout=30)
        validate_resources(skill)
        properties = json.loads(subprocess.check_output(
            [validator, "read-properties", str(skill)], text=True, timeout=30,
        ))
        validate_license(skill, root / "LICENSE", properties.get("license"))
        print(f"Resource validation passed: {skill.name}")


if __name__ == "__main__":
    main()

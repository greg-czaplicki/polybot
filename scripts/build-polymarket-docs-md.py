#!/usr/bin/env python3
"""Generate a project-local Polymarket API markdown reference.

This script is intentionally lightweight and dependency-free.
It can optionally pull docs index metadata from llms.txt and inject it into the output.
"""

from __future__ import annotations

import argparse
import datetime as dt
import pathlib
import re
import textwrap
import urllib.error
import urllib.request

DEFAULT_TEMPLATE = pathlib.Path("docs/polymarket-api.template.md")
DEFAULT_OUTPUT = pathlib.Path("docs/polymarket-api.md")
DEFAULT_LLMS_URL = "https://docs.polymarket.com/llms.txt"


def fetch_text(url: str, timeout: int = 10) -> str | None:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return response.read().decode(charset, errors="replace")
    except (urllib.error.URLError, TimeoutError, ValueError):
        return None


def extract_doc_links(text: str, max_links: int = 20) -> list[str]:
    links = re.findall(r"https?://[^\s)]+", text)
    seen: set[str] = set()
    result: list[str] = []
    for link in links:
        cleaned = link.rstrip(".,")
        if cleaned in seen:
            continue
        seen.add(cleaned)
        result.append(cleaned)
        if len(result) >= max_links:
            break
    return result


def build_links_section(llms_text: str | None) -> str:
    if not llms_text:
        return "- Could not fetch `llms.txt` during generation."

    links = extract_doc_links(llms_text)
    if not links:
        return "- `llms.txt` fetched, but no links were parsed."

    bullets = "\n".join(f"- {link}" for link in links)
    return bullets


def render(template: str, changelog_note: str) -> str:
    now = dt.datetime.now(dt.timezone.utc)
    rendered = template.replace("{{LAST_VERIFIED}}", now.strftime("%Y-%m-%d %H:%M UTC"))
    rendered = rendered.replace("{{CHANGELOG_NOTE}}", changelog_note)
    return rendered


def append_discovery_block(markdown: str, llms_links_block: str) -> str:
    block = textwrap.dedent(
        f"""

        ## Doc Discovery Snapshot
        Source: `{DEFAULT_LLMS_URL}`

        {llms_links_block}
        """
    ).strip("\n")
    return f"{markdown}\n\n{block}\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Build docs/polymarket-api.md from template.")
    parser.add_argument(
        "--template",
        default=str(DEFAULT_TEMPLATE),
        help="Template markdown file path.",
    )
    parser.add_argument(
        "--out",
        default=str(DEFAULT_OUTPUT),
        help="Output markdown file path.",
    )
    parser.add_argument(
        "--changelog-note",
        default="Initial generated reference.",
        help="Single-line changelog note inserted into template.",
    )
    parser.add_argument(
        "--skip-llms",
        action="store_true",
        help="Skip fetching docs index from llms.txt.",
    )
    args = parser.parse_args()

    template_path = pathlib.Path(args.template)
    out_path = pathlib.Path(args.out)

    if not template_path.exists():
        raise SystemExit(f"Template not found: {template_path}")

    template_text = template_path.read_text(encoding="utf-8")
    output = render(template_text, args.changelog_note)

    llms_text = None if args.skip_llms else fetch_text(DEFAULT_LLMS_URL)
    links_block = build_links_section(llms_text)
    output = append_discovery_block(output, links_block)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(output, encoding="utf-8")

    print(f"Wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

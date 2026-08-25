from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime
from hashlib import sha256
import re
from markdown_it import MarkdownIt

class MarkdownError(Exception): pass
class HeadingNotFound(MarkdownError): pass
class AmbiguousHeading(MarkdownError):
    def __init__(self, heading: str, candidates: list[list[str]]):
        super().__init__(f"Heading '{heading}' is ambiguous")
        self.heading = heading
        self.candidates = candidates

@dataclass(frozen=True)
class Heading:
    level: int
    title: str
    path: tuple[str, ...]
    start_line: int
    end_line: int

_md = MarkdownIt("commonmark")


def hash_bytes(data: bytes) -> str:
    return "sha256:" + sha256(data).hexdigest()


def detect_newline(text: str) -> str:
    return "\r\n" if "\r\n" in text else "\n"


def headings(text: str) -> list[Heading]:
    tokens = _md.parse(text)
    raw: list[tuple[int,str,int]] = []
    for i, tok in enumerate(tokens):
        if tok.type != "heading_open" or not tok.map:
            continue
        level = int(tok.tag[1:])
        title = ""
        if i + 1 < len(tokens) and tokens[i+1].type == "inline":
            title = tokens[i+1].content.strip()
        raw.append((level, title, tok.map[0]))
    lines = text.splitlines(keepends=True)
    result: list[Heading] = []
    stack: list[tuple[int,str]] = []
    for idx, (level, title, start) in enumerate(raw):
        stack = [(l,t) for l,t in stack if l < level]
        stack.append((level,title))
        path = tuple(t for _,t in stack)
        end = len(lines)
        for nlevel, _ntitle, nstart in raw[idx+1:]:
            if nlevel <= level:
                end = nstart
                break
        result.append(Heading(level,title,path,start,end))
    return result


def heading_dicts(text: str) -> list[dict]:
    return [{"level":h.level,"title":h.title,"path":list(h.path),"start_line":h.start_line,"end_line":h.end_line} for h in headings(text)]


def resolve_heading(text: str, heading: str | None = None, heading_path: list[str] | None = None) -> Heading:
    hs = headings(text)
    if heading_path:
        target = tuple(x.strip() for x in heading_path)
        exact = [h for h in hs if h.path == target]
        if len(exact) == 1:
            return exact[0]
        if len(exact) > 1:
            raise AmbiguousHeading(" > ".join(target), [list(h.path) for h in exact])
        raise HeadingNotFound(" > ".join(target))
    if heading is None:
        raise HeadingNotFound("<missing>")
    matches = [h for h in hs if h.title.casefold() == heading.strip().casefold()]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise HeadingNotFound(heading)
    raise AmbiguousHeading(heading, [list(h.path) for h in matches])


def _join_insertion(text: str, insertion: str) -> str:
    nl = detect_newline(text)
    if not text:
        return insertion.rstrip("\r\n") + nl
    prefix = "" if text.endswith(nl + nl) else (nl if text.endswith(nl) else nl + nl)
    return text + prefix + insertion.strip("\r\n") + nl


def append_under_heading(text: str, content: str, *, heading: str | None = None, heading_path: list[str] | None = None) -> str:
    target = resolve_heading(text, heading=heading, heading_path=heading_path)
    lines = text.splitlines(keepends=True)
    nl = detect_newline(text)
    insert_at = target.end_line
    before = "".join(lines[:insert_at])
    after = "".join(lines[insert_at:])
    body = content.strip("\r\n")
    prefix = ""
    if before and not before.endswith(("\n","\r")):
        prefix += nl
    if before and not before.endswith(nl + nl):
        prefix += nl
    insertion = prefix + body + nl
    if after and not insertion.endswith(nl + nl) and not after.startswith(("\n","\r")):
        insertion += nl
    return before + insertion + after


def replace_heading_body(text: str, content: str, *, heading: str | None = None, heading_path: list[str] | None = None) -> str:
    """Replace only the body/subtree under an exact heading, preserving the heading line itself.

    The target section ends at the next heading of the same or higher level. Headings inside
    fenced code blocks are ignored by markdown-it, so they cannot accidentally become targets.
    """
    target = resolve_heading(text, heading=heading, heading_path=heading_path)
    lines = text.splitlines(keepends=True)
    nl = detect_newline(text)
    heading_line_end = target.start_line + 1
    before = "".join(lines[:heading_line_end])
    after = "".join(lines[target.end_line:])
    body = content.strip("\r\n")
    insertion = nl + body + nl if body else nl
    if after and not insertion.endswith(nl + nl) and not after.startswith(("\n", "\r")):
        insertion += nl
    return before + insertion + after


def create_note(title: str, body: str = "") -> str:
    title = title.strip() or "Untitled"
    body = body.strip("\r\n")
    # Preserve a captured H1 rather than creating a duplicate title.
    first = body.lstrip().splitlines()[0] if body.lstrip() else ""
    if first.startswith("# "):
        return body + ("" if body.endswith("\n") else "\n")
    return f"# {title}\n" + (f"\n{body}\n" if body else "")


def semantic_title(content: str, fallback: str = "Update") -> str:
    """Deterministic, non-LLM title suggestion used when AI is absent.

    It intentionally prefers the first meaningful Markdown/plain-text line and removes
    obvious formatting/source noise. This keeps saving fast and offline.
    """
    for raw in content.splitlines():
        s = raw.strip()
        if not s or s.startswith(("```", "---", "<<<")):
            continue
        s = re.sub(r"^#{1,6}\s+", "", s)
        s = re.sub(r"^[-*+>]\s+", "", s)
        s = re.sub(r"\s+", " ", s).strip(" -*_`:#")
        if not s:
            continue
        # Prefer a short sentence/title fragment.
        s = re.split(r"(?<=[.!?])\s+", s)[0]
        words = s.split()
        if len(words) > 8:
            s = " ".join(words[:8])
        if len(s) > 72:
            s = s[:69].rstrip() + "…"
        return s or fallback
    return fallback


def dated_heading(title: str, level: int = 2, now: datetime | None = None, existing_text: str = "") -> str:
    now = now or datetime.now()
    title = semantic_title(title, "Update") if "\n" in title else (title.strip() or "Update")
    base = f"{title} — {now:%Y-%m-%d}"
    marker = "#" * max(1, min(level, 6))
    candidate = f"{marker} {base}"
    if candidate.casefold() not in existing_text.casefold():
        return candidate
    return f"{marker} {base} {now:%H:%M}"


def append_dated_update(text: str, content: str, title: str | None = None, now: datetime | None = None) -> str:
    title = title or semantic_title(content, "Update")
    section = f"{dated_heading(title, 2, now, text)}\n\n{content.strip()}"
    return _join_insertion(text, section)


def append_under_heading_dated(text: str, content: str, *, heading: str | None = None, heading_path: list[str] | None = None,
                               title: str | None = None, now: datetime | None = None) -> str:
    target = resolve_heading(text, heading=heading, heading_path=heading_path)
    child_level = min(target.level + 1, 6)
    title = title or semantic_title(content, "Update")
    section = f"{dated_heading(title, child_level, now, text)}\n\n{content.strip()}"
    return append_under_heading(text, section, heading_path=list(target.path))


def suggest_headings(content: str, count: int = 3) -> list[str]:
    """Return 2-3 deterministic heading suggestions without blocking on an LLM."""
    candidates: list[str] = []
    primary = semantic_title(content, "Update")
    if primary:
        candidates.append(primary)
    # Build extra suggestions from meaningful lines / early keywords.
    for raw in content.splitlines()[1:12]:
        s = semantic_title(raw, "")
        if s and len(s) >= 4 and s.casefold() not in {x.casefold() for x in candidates}:
            candidates.append(s)
        if len(candidates) >= count:
            break
    defaults = ["Key Findings", "Additional Notes", "Update"]
    for d in defaults:
        if d.casefold() not in {x.casefold() for x in candidates}:
            candidates.append(d)
        if len(candidates) >= count:
            break
    return candidates[:max(2, min(count, 3))]

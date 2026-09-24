#!/usr/bin/env python3
"""Separately-authored Python bridge for deterministic Hermes citation checking.

Called only by the host checker, with a host-resolved interpreter and a fixed
script path: ``<python3> -I -S -B -X utf8 hermes-citations-bridge.py``. It reads
one JSON object on stdin and writes exactly one JSON object on stdout. It reads
no caller-supplied code, no tokens and no environment variables, and writes only
inside the temporary working directory the host created for this single run.

It checks *references*: whether each ``[n]`` marker in a draft resolves to a
source the person selected, and whether the Sources block agrees with that
selection. It also checks recognized inline quoted text against explicitly
selected source bodies using the original Hermes matcher; neither check proves a claim true.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import sys
import time
from pathlib import Path

MIN_PYTHON = (3, 9)
MAX_SOURCES = 64
DISCLAIMER = (
    "Checks numbered [n] references against the sources you selected on this Mac. "
    "It does not check other citation styles, and it does not judge whether any claim is true."
)

_UUID_MARKER_RE = re.compile(
    r"\[(?:urn:rellane:source:)?"
    r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\]"
)
_INLINE_CODE_RE = re.compile(r"(`+)(?:(?!\1)[^\r\n])*\1")
_QUOTE_CITE_RE = re.compile(
    r'(?:"([^"\r\n]{1,1000})"|“([^”\r\n]{1,1000})”)[^\S\r\n]*'
    r'(\[\d{1,4}\]|\[(?:urn:rellane:source:)?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\])'
)
_MULTI_CITE_FOLLOWING_RE = re.compile(
    r'^[^\S\r\n]*(?:,[^\S\r\n]*)?\[(?:\d{1,4}|(?:urn:rellane:source:)?[0-9a-fA-F-]{36})\]'
)

# Reference forms this checker does not resolve. Saying so is the difference
# between "these numbers line up" and an unearned clean bill of health.
_UNCHECKED_FORMS = (
    (re.compile(r"\[\^[^\]\s]{1,64}\]"), "Footnote-style references ([^1]) were not checked."),
    (re.compile(r"\]\((?:https?|urn):[^)\s]{1,500}\)"), "Inline markdown links were not checked."),
    (re.compile(r"https?://"), "Bare URLs in the text were not checked."),
    (
        re.compile(r"\([A-Z][^()\d]{1,40},\s*(?:1[89]|20)\d{2}[a-z]?\)"),
        "Author-date references such as (Author, 2024) were not checked.",
    ),
)


def _result(
    status,
    summary,
    sources,
    cited_ids,
    unknown_refs,
    missing,
    unexpected,
    mismatched,
    expected_block,
    stats,
    warnings,
    errors,
    quotes=None,
    quote_check_note="",
):
    """The one result shape the host accepts; extra or missing keys are rejected there."""
    return {
        "status": status,
        "summary": summary,
        "disclaimer": DISCLAIMER,
        "sources": sources,
        "citedIds": cited_ids,
        "unknownReferences": unknown_refs,
        "missingFromSourcesBlock": missing,
        "unexpectedInSourcesBlock": unexpected,
        "mismatchedUrls": mismatched,
        "expectedSourcesBlock": expected_block,
        "stats": stats,
        "runtime": "Python %d.%d.%d" % sys.version_info[:3],
        "warnings": warnings,
        "errors": errors,
        "quotes": quotes if quotes is not None else [],
        "quoteCheckNote": quote_check_note,
    }


def _unavailable(summary, errors, sources=None):
    return _result(
        "unavailable",
        summary,
        sources or [],
        [],
        [],
        [],
        [],
        [],
        "",
        "",
        [],
        errors,
        quotes=[],
        quote_check_note="No quoted passages were checked.",
    )


def _run(raw_text):
    payload = json.loads(raw_text)
    if not isinstance(payload, dict):
        raise ValueError("Input payload must be a JSON object.")

    upstream_dir = str(payload.get("upstreamDir", "")).strip()
    if not upstream_dir or not os.path.isdir(upstream_dir):
        raise RuntimeError("The host did not provide a readable upstream scripts directory.")
    # -I keeps this script's own directory off sys.path, so the pinned upstream
    # module is reachable only because the host named its hash-verified directory.
    if upstream_dir not in sys.path:
        sys.path.insert(0, upstream_dir)
    import sources as upstream  # noqa: E402

    draft = payload.get("draft", "")
    if not isinstance(draft, str):
        raise ValueError("draft must be a string.")
    raw_sources = payload.get("sources", [])
    if not isinstance(raw_sources, list) or len(raw_sources) > MAX_SOURCES:
        raise ValueError("sources must be a list of at most %d entries." % MAX_SOURCES)
    raw_source_bodies = payload.get("sourceBodies") or {}
    source_bodies = {}
    if isinstance(raw_source_bodies, dict):
        for k, v in raw_source_bodies.items():
            try:
                source_bodies[int(k)] = str(v)
            except (ValueError, TypeError):
                pass

    today = time.strftime("%Y-%m-%d")
    echoed = []
    ledger_sources = []
    by_turn_id = {}
    for item in raw_sources:
        if not isinstance(item, dict):
            raise ValueError("Each selected source must be a JSON object.")
        sid = int(item["id"])
        turn_id = str(item["sourceTurnId"])
        label = str(item.get("label", ""))
        uri = upstream.normalize_url(str(item["uri"]))
        by_turn_id[turn_id.lower()] = sid
        echoed.append({"id": sid, "sourceTurnId": turn_id, "label": label, "uri": uri})
        ledger_sources.append({"id": sid, "url": uri, "title": label, "accessed": today})

    # Temporary, single-run ledger. Never the default $HERMES_HOME location.
    work_dir = Path.cwd()
    upstream.save_ledger(
        work_dir / "ledger.json",
        {"version": upstream.SCHEMA_VERSION, "sources": ledger_sources},
    )

    unknown_markers = []

    def _swap(match):
        matched = by_turn_id.get(match.group(1).lower())
        if matched is not None:
            return "[%d]" % matched
        unknown_markers.append(match.group(0))
        return match.group(0)

    normalized_draft = _UUID_MARKER_RE.sub(_swap, draft)
    draft_path = work_dir / "draft.md"
    draft_path.write_text(normalized_draft, encoding="utf-8")

    prose, listed = upstream._split_draft(normalized_draft)
    cited_set = {int(m) for m in upstream._CITE_RE.findall(prose)}
    by_id = {entry["id"]: entry for entry in ledger_sources}

    unchecked = []
    for pattern, message in _UNCHECKED_FORMS:
        if pattern.search(prose) and message not in unchecked:
            unchecked.append(message)

    if not cited_set and not unknown_markers:
        expected = (
            upstream.render_sources(ledger_sources, style="markdown") if ledger_sources else ""
        )
        return _result(
            "uncited",
            "No numbered [n] references were found, so nothing could be checked.",
            echoed,
            [],
            [],
            [],
            sorted(listed.keys()),
            [],
            expected,
            "",
            ["Write [1], [2] after the sentences each selected source supports."] + unchecked,
            [],
            quotes=[],
            quote_check_note="No quoted passages were checked.",
        )

    _code, errors, raw_warnings = upstream.verify_draft(
        draft_path, ledger_sources, strict=False, min_coverage=None, require_evidence=False
    )
    errors = list(errors)

    unknown_refs = ["[%d]" % i for i in sorted(cited_set) if i not in by_id]
    for marker in unknown_markers:
        if marker not in unknown_refs:
            unknown_refs.append(marker)
            errors.append("reference %s does not match any selected source" % marker)

    missing = sorted(cited_set - set(listed)) if listed else sorted(cited_set)
    unexpected = sorted(set(listed) - cited_set)

    mismatched = []
    for sid, url in sorted(listed.items()):
        entry = by_id.get(sid)
        if entry is not None and upstream.normalize_url(url) != entry["url"]:
            mismatched.append("[%d] %s does not match %s" % (sid, url, entry["url"]))

    expected = upstream.render_sources(
        ledger_sources, style="markdown", only=cited_set or None
    )

    stats = ""
    warnings = []
    for warning in raw_warnings:
        if warning.startswith("stats: "):
            stats = warning[len("stats: "):]
        else:
            warnings.append(warning)
    warnings.extend(unchecked)

    if errors:
        status = "mismatch"
        summary = "%d reference problem%s found." % (
            len(errors),
            "" if len(errors) == 1 else "s",
        )
    else:
        status = "ok"
        summary = "All %d numbered reference%s resolve to the sources you selected." % (
            len(cited_set),
            "" if len(cited_set) == 1 else "s",
        )

    raw_quotes = []
    quote_limit_reached = False
    for line in prose.splitlines():
        if line.lstrip().startswith(">"):
            continue
        masked_line = _INLINE_CODE_RE.sub(lambda m: " " * len(m.group(0)), line)
        for m in _QUOTE_CITE_RE.finditer(masked_line):
            quote_text = m.group(1) or m.group(2)
            if not quote_text.strip():
                continue
            after_match = masked_line[m.end():]
            if _MULTI_CITE_FOLLOWING_RE.match(after_match):
                continue
            citation_str = m.group(3)
            if len(citation_str) > 128:
                continue

            if len(raw_quotes) >= 40:
                quote_limit_reached = True
                break

            num_match = re.match(r"^\[(\d{1,4})\]$", citation_str)
            if num_match:
                target_sid = int(num_match.group(1))
            else:
                uuid_match = _UUID_MARKER_RE.match(citation_str)
                if uuid_match:
                    target_sid = by_turn_id.get(uuid_match.group(1).lower())
                else:
                    target_sid = None

            if target_sid is None or target_sid not in by_id:
                quote_status = "source_not_selected"
            else:
                evidence = source_bodies.get(target_sid, "")
                if upstream.quote_in_evidence(quote_text, evidence):
                    quote_status = "matched"
                else:
                    quote_status = "not_found"

            raw_quotes.append({
                "quote": quote_text,
                "citation": citation_str,
                "status": quote_status,
            })
        if quote_limit_reached:
            break

    if quote_limit_reached:
        quotes = raw_quotes[:40]
        quote_check_note = (
            "Checks inline quotes followed by one source reference. "
            "Matches ignore case, spacing and Markdown. A match does not prove the claim. "
            "Only the first 40 quoted passages were checked."
        )
    elif len(raw_quotes) == 0:
        quotes = []
        quote_check_note = "No quoted passages were checked."
    else:
        quotes = raw_quotes
        quote_check_note = (
            "Checks inline quotes followed by one source reference. "
            "Matches ignore case, spacing and Markdown. A match does not prove the claim."
        )

    return _result(
        status,
        summary,
        echoed,
        sorted(cited_set),
        unknown_refs,
        missing,
        unexpected,
        mismatched,
        expected,
        stats,
        warnings,
        errors,
        quotes=quotes,
        quote_check_note=quote_check_note,
    )


def main():
    if sys.version_info < MIN_PYTHON:
        found = "%d.%d.%d" % sys.version_info[:3]
        sys.stdout.write(
            json.dumps(
                _unavailable(
                    "Python 3.9 or newer is required for citation checking.",
                    ["This Mac ran the checker with Python %s." % found],
                )
            )
            + "\n"
        )
        return 0

    try:
        raw_text = sys.stdin.read()
    except Exception as exc:
        sys.stdout.write(
            json.dumps(
                _unavailable(
                    "The citation checker could not read its input.", [str(exc)[:500]]
                )
            )
            + "\n"
        )
        return 0

    if not raw_text.strip():
        result = _unavailable(
            "The citation checker received no input.", ["Input was empty."]
        )
    else:
        try:
            # stdout carries exactly one JSON object, so anything the upstream
            # module prints is diverted to stderr rather than corrupting it.
            with contextlib.redirect_stdout(sys.stderr):
                result = _run(raw_text)
        except Exception as exc:
            result = _unavailable(
                "The citation check could not be completed.",
                ["%s: %s" % (type(exc).__name__, str(exc)[:500])],
            )

    # ASCII-only JSON: valid whatever encoding stdout ends up with.
    sys.stdout.write(json.dumps(result) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())

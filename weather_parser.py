#!/usr/bin/env python3
"""Extract weather-related text from Simple English Wikipedia's Weather page."""

from __future__ import annotations

import re
from html.parser import HTMLParser
from urllib.request import Request, urlopen
from urllib.parse import urljoin

URL = "https://simple.wikipedia.org/wiki/Weather"


class ArticleParser(HTMLParser):
    """Collect title, paragraphs, and links without third-party packages."""

    def __init__(self) -> None:
        super().__init__()
        self.title_parts: list[str] = []
        self.paragraphs: list[str] = []
        self.weather_links: list[str] = []
        self._active_tag: str | None = None
        self._text_parts: list[str] = []
        self._current_link: tuple[str, list[str]] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag in {"title", "p"}:
            self._active_tag = tag
            self._text_parts = []
        if tag == "a" and attributes.get("href"):
            self._current_link = (attributes["href"] or "", [])

    def handle_data(self, data: str) -> None:
        if self._active_tag in {"title", "p"}:
            self._text_parts.append(data)
        if self._current_link:
            self._current_link[1].append(data)

    def handle_endtag(self, tag: str) -> None:
        text = " ".join("".join(self._text_parts).split())
        if tag == "title" and self._active_tag == "title":
            self.title_parts.append(text)
        elif tag == "p" and self._active_tag == "p" and text:
            self.paragraphs.append(text)
        if tag == "a" and self._current_link:
            href, link_text = self._current_link
            if "weather" in " ".join(link_text).lower():
                self.weather_links.append(urljoin(URL, href))
            self._current_link = None
        if tag == self._active_tag:
            self._active_tag = None
            self._text_parts = []


def fetch_weather_page() -> ArticleParser:
    request = Request(URL, headers={"User-Agent": "weather-parser/1.0"})
    with urlopen(request, timeout=15) as response:
        html = response.read().decode("utf-8", errors="replace")
    parser = ArticleParser()
    parser.feed(html)
    return parser


def extract_weather_data(parser: ArticleParser) -> dict[str, object]:
    """Return page metadata and weather-related sentences from the article."""
    title = parser.title_parts[0] if parser.title_parts else ""
    paragraphs = parser.paragraphs

    weather_sentences: list[str] = []
    weather_terms = re.compile(
        r"\b(weather|temperature|rain|snow|wind|cloud|storm|humidity|forecast)\b",
        re.IGNORECASE,
    )
    for paragraph in paragraphs:
        weather_sentences.extend(
            sentence.strip()
            for sentence in re.split(r"(?<=[.!?])\s+", paragraph)
            if weather_terms.search(sentence)
        )

    return {
        "title": title,
        "source_url": URL,
        "weather_sentences": weather_sentences,
        "related_weather_links": sorted(set(parser.weather_links)),
    }


def main() -> None:
    data = extract_weather_data(fetch_weather_page())
    print(f"Title: {data['title']}")
    print(f"Source: {data['source_url']}")
    print("\nWeather-related text:")
    for sentence in data["weather_sentences"]:
        print(f"- {sentence}")

    print("\nRelated links:")
    for link in data["related_weather_links"]:
        print(f"- {link}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3

import requests
from bs4 import BeautifulSoup


URL = "https://simple.wikipedia.org/wiki/Weather"


def main() -> None:
    response = requests.get(URL, timeout=15)
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")
    title = soup.title.get_text(strip=True) if soup.title else "Weather"
    paragraphs = [
        paragraph.get_text(" ", strip=True)
        for paragraph in soup.find_all("p")
        if paragraph.get_text(strip=True)
    ]

    print(title)
    print(f"Date: {__import__('datetime').date.today().isoformat()}")
    print("\n".join(paragraphs[:3]))


if __name__ == "__main__":
    main()

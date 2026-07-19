#!/usr/bin/env python3
"""获取并打印广州天气预报。

优先调用高德天气 API；未提供高德 key 或高德请求失败时，自动使用
无需 API key 的 Open-Meteo 作为 fallback。

示例：
    AMAP_API_KEY=你的高德key python3 guangzhou_weather.py
    python3 guangzhou_weather.py --amap-key 你的高德key
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


AMAP_WEATHER_URL = "https://restapi.amap.com/v3/weather/weatherInfo"
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
GUANGZHOU = {"city": "广州", "adcode": "440100", "latitude": 23.1291, "longitude": 113.2644}


def get_json(url: str, params: dict[str, str | int]) -> dict:
    query = urlencode(params)
    request = Request(f"{url}?{query}", headers={"User-Agent": "guangzhou-weather/1.0"})
    with urlopen(request, timeout=15) as response:
        return json.load(response)


def fetch_amap(api_key: str) -> list[str]:
    data = get_json(
        AMAP_WEATHER_URL,
        {"key": api_key, "city": GUANGZHOU["adcode"], "extensions": "all", "output": "JSON"},
    )
    if data.get("status") != "1":
        raise RuntimeError(f"高德返回错误: {data.get('info', '未知错误')} (infocode={data.get('infocode', '未知')})")

    forecasts = data.get("forecasts") or []
    if not forecasts or not forecasts[0].get("casts"):
        raise RuntimeError("高德返回成功，但没有天气预报数据")

    city = forecasts[0].get("city", GUANGZHOU["city"])
    lines = [f"数据来源：高德天气 API（{city}）"]
    for cast in forecasts[0]["casts"]:
        lines.append(
            f"{cast.get('date', '?')} {cast.get('week', '')}："
            f"{cast.get('dayweather', '?')}，{cast.get('nightweather', '?')}；"
            f"{cast.get('nighttemp', '?')}~{cast.get('daytemp', '?')}°C；"
            f"白天风向 {cast.get('daywind', '?')} {cast.get('daypower', '?')}级"
        )
    return lines


def fetch_open_meteo() -> list[str]:
    data = get_json(
        OPEN_METEO_URL,
        {
            "latitude": GUANGZHOU["latitude"],
            "longitude": GUANGZHOU["longitude"],
            "timezone": "Asia/Shanghai",
            "forecast_days": 4,
            "current": "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m",
            "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max",
        },
    )
    current = data.get("current") or {}
    daily = data.get("daily") or {}
    dates = daily.get("time") or []
    lines = [
        "数据来源：Open-Meteo（无需 API key；因高德不可用而启用）",
        f"当前：{current.get('temperature_2m', '?')}°C，"
        f"湿度 {current.get('relative_humidity_2m', '?')}%，"
        f"风速 {current.get('wind_speed_10m', '?')} km/h，"
        f"天气代码 {current.get('weather_code', '?')}",
    ]
    for index, date in enumerate(dates):
        lines.append(
            f"{date}：天气代码 {daily['weather_code'][index]}；"
            f"{daily['temperature_2m_min'][index]}~{daily['temperature_2m_max'][index]}°C；"
            f"降水概率 {daily['precipitation_probability_max'][index]}%；"
            f"最大风速 {daily['wind_speed_10m_max'][index]} km/h"
        )
    return lines


def main() -> int:
    parser = argparse.ArgumentParser(description="打印广州天气预报")
    parser.add_argument("--amap-key", default=os.getenv("AMAP_API_KEY"), help="高德天气 API key，也可用 AMAP_API_KEY")
    args = parser.parse_args()

    print(f"广州天气预报（查询时间：{datetime.now().astimezone().strftime('%Y-%m-%d %H:%M:%S %z')}）")
    amap_reason = "未配置高德 API key"
    if args.amap_key:
        try:
            print("\n".join(fetch_amap(args.amap_key)))
            return 0
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, RuntimeError) as exc:
            amap_reason = f"高德 API 访问失败：{exc}"
    print(f"高德 API 未使用：{amap_reason}", file=sys.stderr)

    try:
        print("\n".join(fetch_open_meteo()))
        return 0
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, RuntimeError) as exc:
        print(f"公开天气 API 也访问失败：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

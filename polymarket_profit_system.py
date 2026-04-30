#!/usr/bin/env python3
"""Polymarket wallet analysis and guarded signal engine."""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

DATA_API = "https://data-api.polymarket.com"

DEFAULT_CONFIG = {
    "analysis_window_days": 90,
    "candidate_categories": ["OVERALL"],
    "candidate_periods": ["MONTH", "ALL"],
    "candidate_limit_per_query": 50,
    "manual_wallets": [],
    "max_wallets_to_analyze": 100,
    "min_closed_positions": 15,
    "min_realized_pnl": 1000,
    "min_roi": 0.03,
    "min_wallet_score": 60,
    "recent_trade_lookback_hours": 12,
    "max_trade_age_minutes": 240,
    "min_trade_cash": 50,
    "max_trade_cash": 50000,
    "min_copy_price": 0.12,
    "max_copy_price": 0.88,
    "max_market_exposure_fraction": 0.08,
    "bankroll": 10000,
    "base_bet_fraction": 0.01,
    "require_consensus_wallets": 1,
    "simulated_trade_days": 15,
    "simulated_trade_amount": 500,
    "out_dir": "out",
}


@dataclass
class WalletScore:
    wallet: str
    name: str
    leaderboard_pnl: float
    leaderboard_vol: float
    realized_pnl: float
    open_pnl: float
    total_bought: float
    roi: float
    win_rate: float
    closed_positions: int
    active_positions: int
    unique_markets_traded: int
    concentration: float
    score: float


@dataclass
class Signal:
    timestamp: int
    wallet: str
    wallet_name: str
    wallet_score: float
    side: str
    market: str
    asset: str
    outcome: str
    price: float
    size: float
    cash: float
    suggested_cash: float
    title: str
    slug: str
    consensus_wallets: int
    transaction_hash: str


def load_config(path: str | None) -> dict[str, Any]:
    config = dict(DEFAULT_CONFIG)
    if path:
        with open(path, "r", encoding="utf-8") as fh:
            config.update(json.load(fh))
    return config


def api_get(path: str, params: dict[str, Any] | None = None, retries: int = 3) -> Any:
    query = urllib.parse.urlencode(params or {}, doseq=True)
    url = f"{DATA_API}{path}"
    if query:
        url = f"{url}?{query}"

    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "polymarket-wallet-system/1.0"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, socket.timeout, json.JSONDecodeError) as exc:
            last_error = exc
            time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"API request failed: {url}: {last_error}")


def as_float(value: Any, default: float = 0.0) -> float:
    try:
        return default if value is None else float(value)
    except (TypeError, ValueError):
        return default


def as_int(value: Any, default: int = 0) -> int:
    try:
        return default if value is None else int(value)
    except (TypeError, ValueError):
        return default


def fetch_candidates(config: dict[str, Any]) -> list[dict[str, Any]]:
    by_wallet: dict[str, dict[str, Any]] = {}
    for row in config.get("manual_wallets", []):
        wallet = row.get("proxyWallet") or row.get("wallet")
        if not wallet:
            continue
        normalized = {
            "proxyWallet": wallet.lower(),
            "userName": row.get("userName") or row.get("name") or wallet,
            "pnl": as_float(row.get("pnl")),
            "vol": as_float(row.get("vol")),
        }
        by_wallet[normalized["proxyWallet"]] = normalized

    for category in config["candidate_categories"]:
        for period in config["candidate_periods"]:
            rows = api_get(
                "/v1/leaderboard",
                {
                    "category": category,
                    "timePeriod": period,
                    "orderBy": "PNL",
                    "limit": config["candidate_limit_per_query"],
                },
            )
            for row in rows:
                wallet = row.get("proxyWallet")
                if not wallet:
                    continue
                wallet_key = wallet.lower()
                previous = by_wallet.get(wallet_key)
                if previous is None or as_float(row.get("pnl")) > as_float(previous.get("pnl")):
                    row["proxyWallet"] = wallet_key
                    by_wallet[wallet_key] = row
    return sorted(by_wallet.values(), key=lambda r: as_float(r.get("pnl")), reverse=True)[: config["max_wallets_to_analyze"]]


def fetch_paginated(path: str, params: dict[str, Any], limit: int, max_offset: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for offset in range(0, max_offset + 1, limit):
        page_params = dict(params)
        page_params.update({"limit": limit, "offset": offset})
        page = api_get(path, page_params)
        if not isinstance(page, list) or not page:
            break
        rows.extend(page)
        if len(page) < limit:
            break
    return rows


def score_wallet(
    realized_pnl: float,
    roi: float,
    win_rate: float,
    closed_count: int,
    unique_markets: int,
    concentration: float,
    open_pnl: float,
) -> float:
    pnl_score = min(30.0, max(0.0, math.log10(max(realized_pnl, 1.0)) * 7.5))
    roi_score = min(20.0, max(0.0, roi * 120.0))
    win_score = min(15.0, max(0.0, (win_rate - 0.45) * 50.0))
    sample_score = min(15.0, closed_count / 3.0)
    market_score = min(10.0, unique_markets / 4.0)
    concentration_penalty = min(20.0, max(0.0, (concentration - 0.35) * 40.0))
    open_penalty = 5.0 if open_pnl < -0.25 * max(realized_pnl, 1.0) else 0.0
    return round(max(0.0, pnl_score + roi_score + win_score + sample_score + market_score - concentration_penalty - open_penalty), 2)


def analyze_wallet(candidate: dict[str, Any], config: dict[str, Any], cutoff_ts: int) -> WalletScore:
    wallet = candidate["proxyWallet"]
    closed = fetch_paginated(
        "/closed-positions",
        {"user": wallet, "sortBy": "TIMESTAMP", "sortDirection": "DESC"},
        limit=50,
        max_offset=1000,
    )
    positions = fetch_paginated(
        "/positions",
        {"user": wallet, "sortBy": "CASHPNL", "sortDirection": "DESC", "sizeThreshold": 0},
        limit=500,
        max_offset=10000,
    )
    trades = fetch_paginated("/trades", {"user": wallet, "takerOnly": "false"}, limit=10000, max_offset=10000)

    closed_window = [p for p in closed if as_int(p.get("timestamp")) >= cutoff_ts]
    trades_window = [t for t in trades if as_int(t.get("timestamp")) >= cutoff_ts]
    realized_pnl = sum(as_float(p.get("realizedPnl")) for p in closed_window)
    total_bought = sum(as_float(p.get("totalBought")) for p in closed_window)
    wins = sum(1 for p in closed_window if as_float(p.get("realizedPnl")) > 0)
    win_rate = wins / len(closed_window) if closed_window else 0.0
    roi = realized_pnl / total_bought if total_bought > 0 else 0.0
    open_pnl = sum(as_float(p.get("cashPnl")) for p in positions)
    unique_markets = len({t.get("conditionId") for t in trades_window if t.get("conditionId")})

    market_cash: Counter[str] = Counter()
    for trade in trades_window:
        market_cash[trade.get("conditionId", "")] += as_float(trade.get("size")) * as_float(trade.get("price"))
    total_trade_cash = sum(market_cash.values())
    concentration = max(market_cash.values()) / total_trade_cash if total_trade_cash else 1.0

    return WalletScore(
        wallet=wallet,
        name=candidate.get("userName") or "",
        leaderboard_pnl=as_float(candidate.get("pnl")),
        leaderboard_vol=as_float(candidate.get("vol")),
        realized_pnl=realized_pnl,
        open_pnl=open_pnl,
        total_bought=total_bought,
        roi=roi,
        win_rate=win_rate,
        closed_positions=len(closed_window),
        active_positions=len(positions),
        unique_markets_traded=unique_markets,
        concentration=concentration,
        score=score_wallet(realized_pnl, roi, win_rate, len(closed_window), unique_markets, concentration, open_pnl),
    )


def write_rows(path: str, rows: list[dict[str, Any]]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if path.endswith(".json"):
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(rows, fh, indent=2, ensure_ascii=False)
        return

    with open(path, "w", newline="", encoding="utf-8") as fh:
        if not rows:
            return
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def build_simulated_trades(
    rankings: list[WalletScore],
    signals: list[Signal] | None,
    watchlist: list[dict[str, Any]],
    config: dict[str, Any],
) -> list[dict[str, Any]]:
    days = int(config.get("simulated_trade_days", 15))
    amount = float(config.get("simulated_trade_amount", 500))
    signal_rows = signals or []
    china_tz = timezone(timedelta(hours=8))
    base_time = datetime.now(china_tz).replace(hour=0, minute=5, second=0, microsecond=0)
    pnl_rates = [-0.036, 0.048, -0.018, 0.062, 0.024, 0.038, -0.026, 0.054, 0.016, -0.012]
    trades: list[dict[str, Any]] = []

    for idx in range(days):
        trade_time = base_time + timedelta(minutes=idx * 9)
        signal = signal_rows[idx % len(signal_rows)] if signal_rows else None
        wallet = rankings[idx % len(rankings)] if rankings else None
        manual = watchlist[idx % len(watchlist)] if watchlist else {}
        entry_price = 0.32 + (idx % 8) * 0.07
        pnl = round(amount * pnl_rates[idx % len(pnl_rates)], 2)
        current_price = max(0.01, min(0.99, entry_price + pnl / amount))

        trades.append(
            {
                "date": trade_time.strftime("%Y-%m-%d %H:%M"),
                "mode": "paper",
                "wallet_name": signal.wallet_name if signal else (wallet.name if wallet else manual.get("userName", "PL钱包")),
                "wallet": signal.wallet if signal else (wallet.wallet if wallet else manual.get("proxyWallet", "")),
                "title": signal.title if signal else f"PL跟单市场 {idx + 1}",
                "outcome": signal.outcome if signal else "YES",
                "side": "BUY",
                "entry_price": round(signal.price if signal else entry_price, 4),
                "current_price": round(current_price, 4),
                "amount": round(amount, 2),
                "shares": round(amount / max(signal.price if signal else entry_price, 0.01), 2),
                "pnl": pnl,
                "status": "PL持仓",
            }
        )
    return trades


def write_web_data(out_dir: str, rankings: list[WalletScore], signals: list[Signal] | None = None) -> None:
    config_path = "config.lite.json" if os.path.exists("config.lite.json") else None
    config = load_config(config_path) if config_path else dict(DEFAULT_CONFIG)
    watchlist = []
    try:
        watchlist = config.get("manual_wallets", [])
    except Exception:
        watchlist = []
    simulated_trades = build_simulated_trades(rankings, signals, watchlist, config)
    data_dir = os.path.join("docs", "data")
    os.makedirs(data_dir, exist_ok=True)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_out_dir": out_dir,
        "manual_wallets": watchlist,
        "simulated_trades": simulated_trades,
        "rankings": [asdict(row) for row in rankings],
        "signals": [asdict(row) for row in signals] if signals is not None else [],
    }
    with open(os.path.join(data_dir, "latest.json"), "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)


def analyze(config: dict[str, Any]) -> list[WalletScore]:
    cutoff_ts = int(time.time()) - int(config["analysis_window_days"]) * 86400
    candidates = fetch_candidates(config)
    scores: list[WalletScore] = []

    for idx, candidate in enumerate(candidates, 1):
        label = candidate.get("userName") or candidate.get("proxyWallet")
        print(f"[{idx}/{len(candidates)}] analyzing {label}", flush=True)
        try:
            score = analyze_wallet(candidate, config, cutoff_ts)
        except Exception as exc:
            print(f"  skipped: {exc}")
            continue

        if (
            score.closed_positions >= config["min_closed_positions"]
            and score.realized_pnl >= config["min_realized_pnl"]
            and score.roi >= config["min_roi"]
        ):
            scores.append(score)

    scores.sort(key=lambda s: s.score, reverse=True)
    rows = [asdict(s) for s in scores]
    write_rows(os.path.join(config["out_dir"], "wallet_rankings.json"), rows)
    write_rows(os.path.join(config["out_dir"], "wallet_rankings.csv"), rows)
    write_web_data(config["out_dir"], scores)
    return scores


def load_rankings(out_dir: str) -> list[WalletScore]:
    with open(os.path.join(out_dir, "wallet_rankings.json"), "r", encoding="utf-8") as fh:
        return [WalletScore(**row) for row in json.load(fh)]


def build_signals(config: dict[str, Any]) -> list[Signal]:
    rankings = [w for w in load_rankings(config["out_dir"]) if w.score >= config["min_wallet_score"]]
    wallet_by_address = {w.wallet: w for w in rankings}
    cutoff_ts = int(time.time()) - int(config["recent_trade_lookback_hours"]) * 3600
    max_age_ts = int(time.time()) - int(config["max_trade_age_minutes"]) * 60

    raw_trades: list[dict[str, Any]] = []
    for wallet in rankings:
        try:
            trades = fetch_paginated("/trades", {"user": wallet.wallet, "takerOnly": "false"}, limit=200, max_offset=1000)
        except Exception as exc:
            print(f"  skipped signals for {wallet.name or wallet.wallet}: {exc}", flush=True)
            continue
        raw_trades.extend(t for t in trades if as_int(t.get("timestamp")) >= cutoff_ts)

    consensus: defaultdict[tuple[str, str, str], set[str]] = defaultdict(set)
    for trade in raw_trades:
        key = (trade.get("conditionId", ""), trade.get("outcome", ""), trade.get("side", ""))
        consensus[key].add(trade.get("proxyWallet", ""))

    signals: list[Signal] = []
    for trade in raw_trades:
        wallet = wallet_by_address.get(trade.get("proxyWallet"))
        if wallet is None:
            continue
        price = as_float(trade.get("price"))
        size = as_float(trade.get("size"))
        cash = price * size
        key = (trade.get("conditionId", ""), trade.get("outcome", ""), trade.get("side", ""))
        consensus_count = len(consensus[key])

        if as_int(trade.get("timestamp")) < max_age_ts:
            continue
        if trade.get("side") != "BUY":
            continue
        if not (config["min_copy_price"] <= price <= config["max_copy_price"]):
            continue
        if not (config["min_trade_cash"] <= cash <= config["max_trade_cash"]):
            continue
        if consensus_count < config["require_consensus_wallets"]:
            continue

        confidence = min(1.5, max(0.25, wallet.score / 100.0))
        suggested_cash = config["bankroll"] * config["base_bet_fraction"] * confidence
        suggested_cash = min(suggested_cash, config["bankroll"] * config["max_market_exposure_fraction"])

        signals.append(
            Signal(
                timestamp=as_int(trade.get("timestamp")),
                wallet=wallet.wallet,
                wallet_name=wallet.name,
                wallet_score=wallet.score,
                side=trade.get("side", ""),
                market=trade.get("conditionId", ""),
                asset=str(trade.get("asset", "")),
                outcome=trade.get("outcome", ""),
                price=price,
                size=size,
                cash=round(cash, 2),
                suggested_cash=round(suggested_cash, 2),
                title=trade.get("title", ""),
                slug=trade.get("slug", ""),
                consensus_wallets=consensus_count,
                transaction_hash=trade.get("transactionHash", ""),
            )
        )

    signals.sort(key=lambda s: (s.timestamp, s.wallet_score), reverse=True)
    rows = [asdict(s) for s in signals]
    write_rows(os.path.join(config["out_dir"], "signals.json"), rows)
    write_rows(os.path.join(config["out_dir"], "signals.csv"), rows)
    write_web_data(config["out_dir"], rankings, signals)
    return signals


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze Polymarket wallets and generate guarded signals.")
    parser.add_argument("command", choices=["analyze", "signals"])
    parser.add_argument("--config", default="config.example.json")
    args = parser.parse_args()

    config = load_config(args.config)
    if args.command == "analyze":
        scores = analyze(config)
        print(f"wrote {len(scores)} ranked wallets to {config['out_dir']}")
    else:
        signals = build_signals(config)
        print(f"wrote {len(signals)} signals to {config['out_dir']}")


if __name__ == "__main__":
    main()

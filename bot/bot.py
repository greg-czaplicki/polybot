import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, List, Tuple


@dataclass
class BotConfig:
	base_url: str
	api_key: str
	min_grade: str
	include_started: bool
	require_microstructure: bool
	market_quality_threshold: float
	min_minutes_to_start: int
	max_minutes_to_start: int
	window_minutes: int
	poll_seconds: int
	max_bets: int
	dry_run: bool
	state_path: str
	poly_api_key: str
	poly_api_secret: str
	poly_api_passphrase: str
	poly_private_key: str
	poly_funder: str
	poly_signature_type: int
	poly_chain_id: int
	poly_clob_host: str
	preflight_only: bool
	preflight_condition_id: str
	poly_usdc_token: str
	poly_conditional_token: str
	low_roi_threshold: float
	stop_on_403: bool
	poll_jitter_ratio: float
	poll_backoff_base: float
	poll_backoff_max: float
	max_calls_per_hour: int
	run_window_start: str
	run_window_end: str
	run_window_tz: str
	placed_ttl_seconds: int
	placed_event_grace_seconds: int
	paper_bankroll: float
	kelly_fraction: float
	max_stake: float
	min_stake: float
	fixed_stake: float
	trade_log_path: str


def _prompt_missing(value: str, label: str, secret: bool = False) -> str:
	if value:
		return value
	if secret:
		try:
			import getpass
			return getpass.getpass(f"{label}: ").strip()
		except Exception:
			pass
	return input(f"{label}: ").strip()


def load_dotenv(path: str) -> None:
	try:
		with open(path, "r", encoding="utf-8") as handle:
			for raw_line in handle:
				line = raw_line.strip()
				if not line or line.startswith("#") or "=" not in line:
					continue
				key, value = line.split("=", 1)
				key = key.strip()
				value = value.strip().strip('"').strip("'")
				if key and key not in os.environ:
					os.environ[key] = value
	except FileNotFoundError:
		return


def env_flag(name: str, default: bool) -> bool:
	value = os.getenv(name)
	if value is None:
		return default
	return value.strip().lower() in {"1", "true", "yes", "on"}


def load_config() -> BotConfig:
	load_dotenv(os.getenv("BOT_ENV_PATH", "bot/.env"))
	base_url = os.getenv("BOT_BASE_URL", "").rstrip("/")
	api_key = os.getenv("BOT_API_KEY", "")
	base_url = _prompt_missing(base_url, "BOT_BASE_URL")
	api_key = _prompt_missing(api_key, "BOT_API_KEY", secret=True)
	if not base_url or not api_key:
		raise RuntimeError("BOT_BASE_URL and BOT_API_KEY are required")
	dry_run = env_flag("BOT_DRY_RUN", True)
	poly_api_key = os.getenv("POLY_API_KEY", "")
	poly_api_secret = os.getenv("POLY_API_SECRET", "")
	poly_api_passphrase = os.getenv("POLY_API_PASSPHRASE", "")
	poly_private_key = os.getenv("POLY_PRIVATE_KEY", "")
	poly_funder = os.getenv("POLY_FUNDER", "")
	poly_signature_type = int(os.getenv("POLY_SIGNATURE_TYPE", "0"))
	poly_chain_id = int(os.getenv("POLY_CHAIN_ID", "137"))
	poly_clob_host = os.getenv("POLY_CLOB_HOST", "https://clob.polymarket.com")
	preflight_only = env_flag("BOT_PREFLIGHT", False)
	preflight_condition_id = os.getenv("BOT_PREFLIGHT_CONDITION_ID", "").strip()
	poly_usdc_token = os.getenv(
		"POLY_USDC_TOKEN", "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
	)
	poly_conditional_token = os.getenv(
		"POLY_CONDITIONAL_TOKEN", "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
	)
	low_roi_threshold = float(os.getenv("BOT_LOW_ROI_THRESHOLD", "0.72"))
	stop_on_403 = env_flag("BOT_STOP_ON_403", True)
	poll_jitter_ratio = float(os.getenv("BOT_POLL_JITTER", "0.2"))
	poll_backoff_base = float(os.getenv("BOT_POLL_BACKOFF_BASE", "2"))
	poll_backoff_max = float(os.getenv("BOT_POLL_BACKOFF_MAX", "120"))
	max_calls_per_hour = int(os.getenv("BOT_MAX_CALLS_PER_HOUR", "120"))
	run_window_start = os.getenv("BOT_RUN_WINDOW_START", "")
	run_window_end = os.getenv("BOT_RUN_WINDOW_END", "")
	run_window_tz = os.getenv("BOT_RUN_WINDOW_TZ", "America/New_York")
	if not dry_run:
		poly_private_key = _prompt_missing(
			poly_private_key, "POLY_PRIVATE_KEY", secret=True
		)
		if poly_signature_type in (1, 2) and not poly_funder:
			poly_funder = _prompt_missing(poly_funder, "POLY_FUNDER", secret=False)
	return BotConfig(
		base_url=base_url,
		api_key=api_key,
		min_grade=os.getenv("BOT_MIN_GRADE", "A"),
		include_started=env_flag("BOT_INCLUDE_STARTED", False),
		require_microstructure=env_flag("BOT_REQUIRE_MICROSTRUCTURE", True),
		market_quality_threshold=float(
			os.getenv("BOT_MARKET_QUALITY_THRESHOLD", "0.72")
		),
		min_minutes_to_start=int(os.getenv("BOT_MIN_MINUTES_TO_START", "15")),
		max_minutes_to_start=int(os.getenv("BOT_MAX_MINUTES_TO_START", "60")),
		window_minutes=int(os.getenv("BOT_WINDOW_MINUTES", "60")),
		poll_seconds=int(os.getenv("BOT_POLL_SECONDS", "20")),
		max_bets=int(os.getenv("BOT_MAX_BETS", "5")),
		dry_run=dry_run,
		state_path=os.getenv("BOT_STATE_PATH", "bot/state.json"),
		poly_api_key=poly_api_key,
		poly_api_secret=poly_api_secret,
		poly_api_passphrase=poly_api_passphrase,
		poly_private_key=poly_private_key,
		poly_funder=poly_funder,
		poly_signature_type=poly_signature_type,
		poly_chain_id=poly_chain_id,
		poly_clob_host=poly_clob_host,
		preflight_only=preflight_only,
		preflight_condition_id=preflight_condition_id,
		poly_usdc_token=poly_usdc_token,
		poly_conditional_token=poly_conditional_token,
		low_roi_threshold=low_roi_threshold,
		stop_on_403=stop_on_403,
		poll_jitter_ratio=poll_jitter_ratio,
		poll_backoff_base=poll_backoff_base,
		poll_backoff_max=poll_backoff_max,
		max_calls_per_hour=max_calls_per_hour,
		run_window_start=run_window_start,
		run_window_end=run_window_end,
		run_window_tz=run_window_tz,
		placed_ttl_seconds=int(os.getenv("BOT_PLACED_TTL_SECONDS", "21600")),
		placed_event_grace_seconds=int(
			os.getenv("BOT_PLACED_EVENT_GRACE_SECONDS", "1800")
		),
		paper_bankroll=float(os.getenv("BOT_PAPER_BANKROLL", "1000")),
		kelly_fraction=float(os.getenv("BOT_KELLY_FRACTION", "0.25")),
		max_stake=float(os.getenv("BOT_MAX_STAKE", "50")),
		min_stake=float(os.getenv("BOT_MIN_STAKE", "1")),
		fixed_stake=float(os.getenv("BOT_FIXED_STAKE", "0")),
		trade_log_path=os.getenv("BOT_TRADE_LOG", "bot/trades.jsonl"),
	)


def load_state(path: str) -> Dict[str, Any]:
	try:
		with open(path, "r", encoding="utf-8") as handle:
			return json.load(handle)
	except FileNotFoundError:
		return {"placed": []}
	except json.JSONDecodeError:
		return {"placed": []}


def save_state(path: str, state: Dict[str, Any]) -> None:
	os.makedirs(os.path.dirname(path), exist_ok=True)
	with open(path, "w", encoding="utf-8") as handle:
		json.dump(state, handle, indent=2, sort_keys=True)


def parse_event_time_seconds(raw_value: Any) -> int | None:
	if raw_value is None:
		return None
	try:
		if isinstance(raw_value, (int, float)):
			value = float(raw_value)
			if value > 1_000_000_000_000:
				value = value / 1000.0
			if value > 0:
				return int(value)
			return None
		text = str(raw_value).strip()
		if not text:
			return None
		if re.fullmatch(r"\d+", text):
			value = int(text)
			if value > 1_000_000_000_000:
				value = value // 1000
			return value if value > 0 else None
		import datetime

		normalized = text.replace("Z", "+00:00")
		dt = datetime.datetime.fromisoformat(normalized)
		if dt.tzinfo is None:
			dt = dt.replace(tzinfo=datetime.timezone.utc)
		return int(dt.timestamp())
	except Exception:
		return None


def minutes_to_start(event_time: Any, now_ts: int | None = None) -> float | None:
	event_ts = parse_event_time_seconds(event_time)
	if event_ts is None:
		return None
	now_value = now_ts if now_ts is not None else int(time.time())
	return (event_ts - now_value) / 60.0


def parse_float(value: Any) -> float | None:
	if isinstance(value, (int, float)):
		float_value = float(value)
		return float_value if float_value == float_value else None
	if isinstance(value, str):
		try:
			parsed = float(value)
			return parsed if parsed == parsed else None
		except Exception:
			return None
	return None


GAME_PROP_KEYWORDS = [
	"nrfi", "yrfi", "btts", "both teams to score",
	"draw no bet", "first goal", "clean sheet", "double result",
]

def get_market_type_label(market_title: str) -> str:
	lower = market_title.lower()
	plain_matchup = ":" not in market_title and re.search(r"\bvs\.?\b", market_title, re.I)
	if "o/u" in lower or "over/under" in lower or "total" in lower:
		return "total"
	if "spread" in lower:
		return "spread"
	if plain_matchup:
		return "moneyline"
	if "moneyline" in lower or "ml" in lower:
		return "moneyline"
	if any(kw in lower for kw in GAME_PROP_KEYWORDS):
		return "prop"
	return "other"


def normalize_matchup_title(market_title: str) -> str:
	matchup = market_title.split(":", 1)[0]
	return matchup.strip().lower()


def get_market_group_key(entry: Dict[str, Any]) -> str | None:
	market_title_raw = entry.get("marketTitle")
	if not isinstance(market_title_raw, str) or not market_title_raw.strip():
		return None
	base = entry.get("eventSlug") or normalize_matchup_title(market_title_raw)
	sport = entry.get("sportSeriesId") or "na"
	market_type = get_market_type_label(market_title_raw)
	return f"{sport}|{base}|{market_type}"


def normalize_placed_meta(state: Dict[str, Any], now_ts: int) -> Dict[str, Dict[str, Any]]:
	meta_raw = state.get("placedMeta")
	meta: Dict[str, Dict[str, Any]] = {}
	if isinstance(meta_raw, dict):
		for condition_id, value in meta_raw.items():
			if not isinstance(condition_id, str) or not condition_id:
				continue
			row = value if isinstance(value, dict) else {}
			placed_at_raw = row.get("placedAt")
			try:
				placed_at = int(placed_at_raw) if placed_at_raw is not None else now_ts
			except Exception:
				placed_at = now_ts
			event_time = row.get("eventTime")
			meta[condition_id] = {
				"placedAt": placed_at,
				"eventTime": event_time,
			}
		return meta

	legacy = state.get("placed", [])
	if isinstance(legacy, list):
		for item in legacy:
			if isinstance(item, str) and item:
				meta[item] = {"placedAt": now_ts, "eventTime": None}
	return meta


def normalize_placed_group_meta(
	state: Dict[str, Any], now_ts: int
) -> Dict[str, Dict[str, Any]]:
	meta_raw = state.get("placedGroupMeta")
	meta: Dict[str, Dict[str, Any]] = {}
	if not isinstance(meta_raw, dict):
		return meta
	for group_key, value in meta_raw.items():
		if not isinstance(group_key, str) or not group_key:
			continue
		row = value if isinstance(value, dict) else {}
		placed_at_raw = row.get("placedAt")
		try:
			placed_at = int(placed_at_raw) if placed_at_raw is not None else now_ts
		except Exception:
			placed_at = now_ts
		meta[group_key] = {
			"placedAt": placed_at,
			"eventTime": row.get("eventTime"),
			"conditionId": row.get("conditionId"),
		}
	return meta


def prune_placed_meta(
	meta: Dict[str, Dict[str, Any]],
	now_ts: int,
	ttl_seconds: int,
	event_grace_seconds: int,
) -> Dict[str, Dict[str, Any]]:
	pruned: Dict[str, Dict[str, Any]] = {}
	for condition_id, row in meta.items():
		event_ts = parse_event_time_seconds(row.get("eventTime"))
		if event_ts is not None:
			if now_ts <= event_ts + event_grace_seconds:
				pruned[condition_id] = row
			continue

		placed_at_raw = row.get("placedAt")
		try:
			placed_at = int(placed_at_raw) if placed_at_raw is not None else now_ts
		except Exception:
			placed_at = now_ts
		if now_ts - placed_at <= ttl_seconds:
			pruned[condition_id] = row
	return pruned


def prune_placed_group_meta(
	meta: Dict[str, Dict[str, Any]],
	now_ts: int,
	ttl_seconds: int,
	event_grace_seconds: int,
) -> Dict[str, Dict[str, Any]]:
	pruned: Dict[str, Dict[str, Any]] = {}
	for group_key, row in meta.items():
		event_ts = parse_event_time_seconds(row.get("eventTime"))
		if event_ts is not None:
			if now_ts <= event_ts + event_grace_seconds:
				pruned[group_key] = row
			continue

		placed_at_raw = row.get("placedAt")
		try:
			placed_at = int(placed_at_raw) if placed_at_raw is not None else now_ts
		except Exception:
			placed_at = now_ts
		if now_ts - placed_at <= ttl_seconds:
			pruned[group_key] = row
	return pruned


def request_json(url: str, api_key: str) -> Dict[str, Any]:
	request = urllib.request.Request(url)
	request.add_header("Authorization", f"Bearer {api_key}")
	request.add_header(
		"User-Agent",
		"Mozilla/5.0 (compatible; PolywhalerBot/1.0; +https://workers.dev)",
	)
	try:
		with urllib.request.urlopen(request, timeout=20) as response:
			payload = response.read().decode("utf-8")
			return json.loads(payload)
	except urllib.error.HTTPError as exc:
		body = ""
		try:
			body = exc.read().decode("utf-8")
		except Exception:
			body = ""
		raise RuntimeError(f"HTTP {exc.code} {exc.reason}: {body}") from exc


def post_json(url: str, api_key: str, payload: Dict[str, Any]) -> Dict[str, Any]:
	request = urllib.request.Request(url, method="POST")
	request.add_header("Authorization", f"Bearer {api_key}")
	request.add_header("Content-Type", "application/json")
	request.add_header(
		"User-Agent",
		"Mozilla/5.0 (compatible; PolywhalerBot/1.0; +https://workers.dev)",
	)
	body = json.dumps(payload).encode("utf-8")
	try:
		with urllib.request.urlopen(request, data=body, timeout=20) as response:
			payload_text = response.read().decode("utf-8")
			return json.loads(payload_text)
	except urllib.error.HTTPError as exc:
		body_text = ""
		try:
			body_text = exc.read().decode("utf-8")
		except Exception:
			body_text = ""
		raise RuntimeError(f"HTTP {exc.code} {exc.reason}: {body_text}") from exc

def request_json_public(url: str) -> Dict[str, Any]:
	request = urllib.request.Request(url)
	request.add_header(
		"User-Agent",
		"Mozilla/5.0 (compatible; PolywhalerBot/1.0; +https://workers.dev)",
	)
	try:
		with urllib.request.urlopen(request, timeout=20) as response:
			payload = response.read().decode("utf-8")
			return json.loads(payload)
	except urllib.error.HTTPError as exc:
		body = ""
		try:
			body = exc.read().decode("utf-8")
		except Exception:
			body = ""
		raise RuntimeError(f"HTTP {exc.code} {exc.reason}: {body}") from exc


def fetch_candidates(config: BotConfig) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
	query = urllib.parse.urlencode(
		{
			"windowMinutes": str(config.window_minutes),
			"minMinutesToStart": str(config.min_minutes_to_start),
			"maxMinutesToStart": str(config.max_minutes_to_start),
			"minGrade": config.min_grade,
			"limit": str(config.max_bets * 3),
			"includeStarted": "true" if config.include_started else "false",
			"requireMicrostructure": "true" if config.require_microstructure else "false",
			"marketQualityThreshold": str(config.market_quality_threshold),
			"debug": "true",
		}
	)
	url = f"{config.base_url}/api/bot/candidates?{query}"
	data = request_json(url, config.api_key)
	return data.get("candidates", []), data.get("debug", {})

def normalize_outcome(value: str) -> str:
	return " ".join(value.strip().lower().split())

_token_cache: Dict[str, List[Dict[str, str]]] = {}

def log_event(event_name: str, **fields: Any) -> None:
	normalized: Dict[str, Any] = {}
	for key, value in fields.items():
		if isinstance(value, float):
			normalized[key] = round(value, 6)
		else:
			normalized[key] = value
	print(
		"[bot]",
		event_name,
		json.dumps(normalized, ensure_ascii=True, separators=(",", ":"), sort_keys=True),
	)

def candidate_context(
	candidate: Dict[str, Any],
) -> Dict[str, Any]:
	entry = candidate.get("entry") or {}
	grade = candidate.get("grade") or {}
	event_label = (
		entry.get("eventTitle")
		or entry.get("eventSlug")
		or entry.get("marketSlug")
		or "-"
	)
	return {
		"conditionId": entry.get("conditionId"),
		"marketGroupKey": get_market_group_key(entry),
		"event": event_label,
		"eventTime": entry.get("eventTime"),
		"minutesToStart": minutes_to_start(entry.get("eventTime")),
		"market": entry.get("marketTitle"),
		"side": entry.get("sharpSide"),
		"grade": grade.get("grade"),
		"signalScore": grade.get("signalScore"),
		"edgeRating": grade.get("edgeRating"),
		"microstructureScore": grade.get("microstructureScore"),
		"warnings": grade.get("warnings"),
	}

def fetch_clob_token_map(condition_id: str) -> List[Dict[str, str]]:
	if not condition_id:
		return []
	if condition_id in _token_cache:
		return _token_cache[condition_id]
	url = f"https://clob.polymarket.com/markets/{condition_id}"
	try:
		data = request_json_public(url)
	except Exception:
		data = {}
	tokens = []
	if isinstance(data, dict):
		tokens = data.get("tokens") or []
	mapped: List[Dict[str, str]] = []
	for token in tokens:
		outcome = token.get("outcome")
		token_id = token.get("token_id") or token.get("tokenId") or token.get("id")
		if outcome and token_id:
			mapped.append({"outcome": str(outcome), "token_id": str(token_id)})
	if mapped:
		_token_cache[condition_id] = mapped
	return mapped

def fetch_token_map(condition_id: str) -> List[Dict[str, str]]:
	if not condition_id:
		return []
	if condition_id in _token_cache:
		return _token_cache[condition_id]
	url = (
		"https://gamma-api.polymarket.com/markets?"
		+ urllib.parse.urlencode(
			{
				"condition_id": condition_id,
				"active": "true",
				"limit": "1",
			}
		)
	)
	try:
		data = request_json_public(url)
	except Exception:
		data = []
	markets: List[Dict[str, Any]] = []
	if isinstance(data, list):
		markets = data
	elif isinstance(data, dict) and "data" in data and isinstance(data["data"], list):
		markets = data["data"]
	if not markets:
		_token_cache[condition_id] = []
		return []
	market = markets[0] or {}
	tokens = market.get("tokens") or []
	mapped: List[Dict[str, str]] = []
	for token in tokens:
		outcome = (
			token.get("outcome")
			or token.get("name")
			or token.get("label")
			or token.get("outcome_name")
		)
		token_id = (
			token.get("token_id")
			or token.get("tokenId")
			or token.get("clobTokenId")
			or token.get("id")
		)
		if outcome and token_id:
			mapped.append({"outcome": str(outcome), "token_id": str(token_id)})
	_token_cache[condition_id] = mapped
	return mapped

def resolve_token_id(entry: Dict[str, Any]) -> str:
	condition_id = entry.get("conditionId")
	if not condition_id:
		return ""
	tokens = fetch_clob_token_map(condition_id)
	if not tokens:
		tokens = fetch_token_map(condition_id)
	if not tokens:
		return ""
	sharp_side = entry.get("sharpSide")
	side_a = (entry.get("sideA") or {}).get("label") or ""
	side_b = (entry.get("sideB") or {}).get("label") or ""
	target_label = side_a if sharp_side == "A" else side_b if sharp_side == "B" else ""
	if target_label:
		target = normalize_outcome(target_label)
		for token in tokens:
			if normalize_outcome(token["outcome"]) == target:
				return token["token_id"]
		for token in tokens:
			if target in normalize_outcome(token["outcome"]):
				return token["token_id"]
	if len(tokens) == 2 and sharp_side in ("A", "B"):
		return tokens[0]["token_id"] if sharp_side == "A" else tokens[1]["token_id"]
	return ""

def build_clob_client(config: BotConfig):
	try:
		from py_clob_client_v2.client import ClobClient
		from py_clob_client_v2.clob_types import ApiCreds
	except Exception as exc:
		raise RuntimeError("py-clob-client-v2 not installed") from exc
	client = ClobClient(
		config.poly_clob_host,
		chain_id=config.poly_chain_id,
		key=config.poly_private_key,
		signature_type=config.poly_signature_type,
		funder=config.poly_funder or None,
	)
	if config.poly_api_key and config.poly_api_secret and config.poly_api_passphrase:
		creds = ApiCreds(
			api_key=config.poly_api_key,
			api_secret=config.poly_api_secret,
			api_passphrase=config.poly_api_passphrase,
		)
	else:
		creds = client.create_or_derive_api_key()
	client.set_api_creds(creds)
	return client

def get_balance_allowance(
	client: Any,
	asset_type: str,
	config: BotConfig,
	token_id: str | None = None,
) -> Dict[str, Any] | None:
	getter = getattr(client, "getBalanceAllowance", None) or getattr(
		client, "get_balance_allowance", None
	)
	if not getter:
		return None
	try:
		params = None
		try:
			from py_clob_client_v2.clob_types import BalanceAllowanceParams, AssetType

			params = BalanceAllowanceParams(
				asset_type=getattr(AssetType, asset_type, asset_type),
				token_id=token_id,
				signature_type=config.poly_signature_type,
			)
		except Exception:
			params = None
		if params is not None:
			return getter(params)
		return getter(
			asset_type=asset_type,
			token_id=token_id,
			signature_type=config.poly_signature_type,
		)
	except Exception as exc:
		try:
			return getter(asset_type, token_id)
		except Exception:
			return {"error": str(exc)}

def execute_live_trade(
	entry: Dict[str, Any],
	stake: float,
	config: BotConfig,
) -> Dict[str, Any]:
	if not config.poly_private_key:
		raise RuntimeError("POLY_PRIVATE_KEY missing for live trading")
	token_id = resolve_token_id(entry)
	if not token_id:
		raise RuntimeError("token_id not found for condition")
	from py_clob_client_v2.clob_types import MarketOrderArgs, OrderType
	client = build_clob_client(config)
	order = MarketOrderArgs(
		token_id=token_id,
		amount=float(stake),
		side="BUY",
		order_type=OrderType.FOK,
	)
	signed = client.create_market_order(order)
	response = client.post_order(signed, OrderType.FOK)
	return {"token_id": token_id, "response": response}

def _coerce_float(value: Any) -> float | None:
	if value is None:
		return None
	try:
		return float(value)
	except (TypeError, ValueError):
		return None

def _response_get(response: Any, *keys: str) -> Any:
	"""Best-effort lookup across dict keys or object attributes."""
	for key in keys:
		if isinstance(response, dict):
			val = response.get(key)
		else:
			val = getattr(response, key, None)
		if val is not None:
			return val
	return None

def parse_fill_from_response(
	response: Any, stake: float, price: float
) -> Dict[str, Any]:
	"""Extract fill details from a CLOB v2 post_order response.

	The exact v2 response shape isn't guaranteed across versions, so this probes
	several candidate field names and falls back to the intended stake/price so
	we never lose the notional. The caller also stores the raw response in
	execution_notes, so anything missed here can be re-parsed later.
	"""
	order_id = _response_get(response, "orderID", "orderId", "id")
	tx = _response_get(
		response, "transactionHash", "transactionHashes", "transactionsHashes"
	)
	if isinstance(tx, (list, tuple)):
		tx = tx[0] if tx else None
	status_raw = _response_get(response, "status", "state")
	success = _response_get(response, "success")
	making = _coerce_float(_response_get(response, "makingAmount", "making_amount"))
	taking = _coerce_float(_response_get(response, "takingAmount", "taking_amount"))
	# Market BUY: USDC spent (making) buys shares received (taking).
	fill_notional = making if making is not None else _coerce_float(stake)
	fill_size = taking
	fill_price: float | None = None
	if fill_notional and fill_size:
		fill_price = fill_notional / fill_size
	# A probability fill price must be in (0, 1]. If the making/taking
	# interpretation is inverted or the amounts are unreliable, fall back to the
	# known stake/entry price (the raw response is kept in executionNotes for
	# later re-parsing rather than trusting a nonsensical value here).
	if fill_price is None or not 0 < fill_price <= 1.0001:
		fill_price = _coerce_float(price)
		fill_notional = _coerce_float(stake)
		fill_size = None
	if fill_price is not None:
		fill_price = round(fill_price, 6)
	if fill_size is None and fill_notional and fill_price:
		fill_size = round(fill_notional / fill_price, 4)
	if status_raw is not None:
		fill_status = str(status_raw)
	elif success is False:
		fill_status = "failed"
	else:
		# FOK order returned without raising -> treat as filled.
		fill_status = "filled"
	return {
		"fillStatus": fill_status,
		"fillPrice": fill_price,
		"fillSize": fill_size,
		"fillNotional": fill_notional,
		"orderId": str(order_id) if order_id is not None else None,
		"exchangeTradeId": str(tx) if tx is not None else None,
	}

def report_execution(
	config: BotConfig, pick_id: str, payload: Dict[str, Any]
) -> None:
	"""Persist execution/fill details back onto the pick record."""
	try:
		post_json(
			f"{config.base_url}/api/bot/picks/execution",
			config.api_key,
			{"id": pick_id, **payload},
		)
	except Exception as exc:
		print("[bot] failed to report execution:", exc)

def report_pick_execution(
	config: BotConfig,
	pick_id: str,
	trade: Dict[str, Any],
	stake: float,
	price: float,
) -> None:
	"""Build and send the execution/fill payload for a freshly created pick.

	Reached only after a successful placement (a failed live order returns
	before the pick is created), so mode is 'paper' (dry-run) or 'live' (real
	fill). Paper rows record intended sizing tagged fillStatus='paper'; live
	rows record the parsed fill plus the raw response in executionNotes.
	"""
	submitted = trade.get("timestamp") or int(time.time())
	if trade.get("mode") == "paper":
		payload: Dict[str, Any] = {
			"executionSubmittedAt": submitted,
			"executionFilledAt": submitted,
			"fillStatus": "paper",
			"fillPrice": price,
			"fillSize": round(stake / price, 4) if price else None,
			"fillNotional": round(stake, 2),
			"fillSlippageBps": 0,
			"executionNotes": "paper",
		}
	else:
		fill = parse_fill_from_response(trade.get("orderResponse"), stake, price)
		slippage_bps = None
		fill_price = fill.get("fillPrice")
		if fill_price and price:
			slippage_bps = round((fill_price - price) / price * 10000, 1)
		try:
			raw_notes = json.dumps(trade.get("orderResponse"), default=str)[:900]
		except Exception:
			raw_notes = str(trade.get("orderResponse"))[:900]
		payload = {
			"executionSubmittedAt": submitted,
			"executionFilledAt": int(time.time()),
			"fillSlippageBps": slippage_bps,
			"executionNotes": raw_notes,
			**fill,
		}
	report_execution(config, pick_id, payload)

def extract_cloudflare_ray_id(error_text: str) -> str | None:
	match = re.search(r"Cloudflare Ray ID:\\s*<strong[^>]*>([^<]+)</strong>", error_text)
	if match:
		return match.group(1).strip()
	match = re.search(r"Cloudflare Ray ID:\\s*([A-Za-z0-9]+)", error_text)
	if match:
		return match.group(1).strip()
	return None

def get_local_time_components(tz_name: str) -> tuple[int, int] | None:
	try:
		import datetime
		import zoneinfo

		tz = zoneinfo.ZoneInfo(tz_name)
		now = datetime.datetime.now(tz=tz)
		return now.hour, now.minute
	except Exception:
		return None

def parse_time_window(value: str) -> tuple[int, int] | None:
	if not value:
		return None
	parts = value.split(":")
	if len(parts) != 2:
		return None
	try:
		hour = int(parts[0])
		minute = int(parts[1])
	except ValueError:
		return None
	if hour < 0 or hour > 23 or minute < 0 or minute > 59:
		return None
	return hour, minute

def is_within_window(
	now_h: int,
	now_m: int,
	start: tuple[int, int],
	end: tuple[int, int],
) -> bool:
	start_minutes = start[0] * 60 + start[1]
	end_minutes = end[0] * 60 + end[1]
	now_minutes = now_h * 60 + now_m
	if start_minutes <= end_minutes:
		return start_minutes <= now_minutes <= end_minutes
	return now_minutes >= start_minutes or now_minutes <= end_minutes

def apply_jitter(base_seconds: float, ratio: float) -> float:
	if ratio <= 0:
		return base_seconds
	try:
		import random
		delta = base_seconds * ratio
		return max(1.0, base_seconds + random.uniform(-delta, delta))
	except Exception:
		return base_seconds

def run_preflight(config: BotConfig) -> None:
	if config.dry_run:
		print("[preflight] BOT_DRY_RUN=true; no live trading checks required.")
		return
	print("[preflight] validating CLOB client and creds...")
	client = build_clob_client(config)
	try:
		ok = client.get_ok()
		server_time = client.get_server_time()
		print("[preflight] clob ok:", ok, "server_time:", server_time)
	except Exception as exc:
		raise RuntimeError(f"preflight failed: {exc}") from exc
	usdc_info = get_balance_allowance(client, "COLLATERAL", config)
	if usdc_info is not None:
		print("[preflight] usdc balance/allowance:", usdc_info)
	else:
		print("[preflight] usdc balance/allowance: unavailable")
	if config.preflight_condition_id:
		entry_stub = {"conditionId": config.preflight_condition_id, "sharpSide": "A"}
		token_id = resolve_token_id(entry_stub)
		if not token_id:
			raise RuntimeError(
				"preflight failed: token_id not found for condition_id "
				f"{config.preflight_condition_id}"
			)
		try:
			mid = client.get_midpoint(token_id)
			print(
				"[preflight] token_id ok:",
				token_id,
				"midpoint:",
				mid,
			)
		except Exception as exc:
			raise RuntimeError(
				f"preflight failed: unable to fetch midpoint for {token_id}: {exc}"
			) from exc
		cond_info = get_balance_allowance(
			client, "CONDITIONAL", config, token_id=token_id
		)
		if cond_info is not None:
			print("[preflight] conditional token balance/allowance:", cond_info)
		else:
			print("[preflight] conditional token balance/allowance: unavailable")

def append_trade_log(path: str, payload: Dict[str, Any]) -> None:
	os.makedirs(os.path.dirname(path), exist_ok=True)
	with open(path, "a", encoding="utf-8") as handle:
		handle.write(json.dumps(payload) + "\n")


GRADE_PROB_DEFAULTS = {
	"A+": 0.60,
	"A": 0.57,
	"B": 0.54,
	"C": 0.52,
	"D": 0.50,
}

COLOR_RESET = "\033[0m"
COLOR_GREEN = "\033[32m"
COLOR_YELLOW = "\033[33m"
COLOR_RED = "\033[31m"
COLOR_CYAN = "\033[36m"

def colorize(text: str, color: str) -> str:
	return f"{color}{text}{COLOR_RESET}"


def kelly_fraction(edge_prob: float, price: float) -> float:
	if price <= 0 or price >= 1:
		return 0.0
	b = (1.0 / price) - 1.0
	q = 1.0 - edge_prob
	numerator = b * edge_prob - q
	if numerator <= 0 or b <= 0:
		return 0.0
	return numerator / b


def place_bet(
	candidate: Dict[str, Any],
	config: BotConfig,
	state: Dict[str, Any],
) -> bool:
	entry = candidate["entry"]
	grade = candidate["grade"]
	grade_label = grade.get("grade", "D")
	price = entry.get("sharpSidePrice")
	if price is None:
		print("[bot] skip missing price", entry.get("marketTitle"))
		return False
	if float(price) >= config.low_roi_threshold:
		print(
			"[bot] skip low ROI",
			entry.get("marketTitle"),
			"price",
			price,
		)
		return False
	prob = GRADE_PROB_DEFAULTS.get(grade_label, 0.50)
	kelly = kelly_fraction(prob, float(price))
	stake = state.get("bankroll", config.paper_bankroll) * kelly * config.kelly_fraction
	if config.fixed_stake > 0:
		stake = config.fixed_stake
	stake = min(stake, config.max_stake)
	if stake < config.min_stake:
		print("[bot] skip tiny stake", entry.get("marketTitle"), "stake", stake)
		return False

	trade = {
		"timestamp": int(time.time()),
		"conditionId": entry.get("conditionId"),
		"marketTitle": entry.get("marketTitle"),
		"sharpSide": entry.get("sharpSide"),
		"price": price,
		"grade": grade_label,
		"signalScore": grade.get("signalScore"),
		"l2ImbalanceNearMid": entry.get("l2ImbalanceNearMid"),
		"l2Disagreement": entry.get("l2Disagreement"),
		"stake": round(stake, 2),
		"mode": "paper" if config.dry_run else "live",
	}
	placed_successfully = False

	if config.dry_run:
		print(
			colorize("[paper]", COLOR_CYAN),
			"bet",
			entry.get("marketTitle"),
			entry.get("sharpSide"),
			"grade",
			colorize(grade_label, COLOR_GREEN if grade_label == "A+" else COLOR_YELLOW),
			"stake",
			round(stake, 2),
		)
		placed_successfully = True
	else:
		try:
			result = execute_live_trade(entry, stake, config)
			trade["tokenId"] = result.get("token_id")
			trade["orderResponse"] = result.get("response")
			print(
				colorize("[live]", COLOR_GREEN),
				"order",
				entry.get("marketTitle"),
				entry.get("sharpSide"),
				"grade",
				colorize(grade_label, COLOR_GREEN if grade_label == "A+" else COLOR_YELLOW),
				"stake",
				round(stake, 2),
			)
			placed_successfully = True
		except Exception as exc:
			trade["mode"] = "paper"
			trade["error"] = str(exc)
			error_text = str(exc)
			ray_id = extract_cloudflare_ray_id(error_text)
			if ray_id:
				trade["cloudflareRayId"] = ray_id
				print(
					colorize("[error]", COLOR_RED),
					"cloudflare block (403) Ray ID:",
					ray_id,
				)
				if config.stop_on_403:
					print(colorize("[bot]", COLOR_YELLOW), "stopping on Cloudflare block")
					append_trade_log(config.trade_log_path, trade)
					sys.exit(1)
			print(colorize("[error]", COLOR_RED), "live trade failed; defaulting to paper:", exc)

	append_trade_log(config.trade_log_path, trade)
	if not placed_successfully:
		return False
	try:
		threshold_used = (
			config.market_quality_threshold if config.require_microstructure else None
		)
		decision_snapshot = {
			"signalScore": grade.get("signalScore"),
			"edgeRating": entry.get("edgeRating"),
			"scoreDifferential": entry.get("scoreDifferential"),
			"marketQualityScore": grade.get("microstructureScore"),
			"thresholdUsed": threshold_used,
			"warnings": grade.get("warnings") or [],
			"candidateComputedAt": grade.get("computedAt"),
			"l2Imbalance": entry.get("l2Imbalance"),
			"l2ImbalanceNearMid": entry.get("l2ImbalanceNearMid"),
			"l2Spread": entry.get("l2Spread"),
			"l2Disagreement": entry.get("l2Disagreement"),
		}
		created = post_json(
			f"{config.base_url}/api/bot/picks",
			config.api_key,
			{
				"conditionId": entry.get("conditionId"),
				"marketTitle": entry.get("marketTitle"),
				"eventTime": entry.get("eventTime"),
				"grade": grade_label,
				"signalScore": grade.get("signalScore"),
				"edgeRating": entry.get("edgeRating"),
				"scoreDifferential": entry.get("scoreDifferential"),
				"sharpSide": entry.get("sharpSide"),
				"price": price,
				"thresholdUsed": threshold_used,
				"marketQualityScore": grade.get("microstructureScore"),
				"warnings": grade.get("warnings") or [],
				"candidateComputedAt": grade.get("computedAt"),
				"l2Imbalance": parse_float(entry.get("l2Imbalance")),
				"l2ImbalanceNearMid": parse_float(entry.get("l2ImbalanceNearMid")),
				"l2Spread": parse_float(entry.get("l2Spread")),
				"l2Disagreement": entry.get("l2Disagreement")
				if isinstance(entry.get("l2Disagreement"), bool)
				else None,
				"decisionSnapshot": decision_snapshot,
			},
		)
		pick_id = (created or {}).get("pick", {}).get("id")
		if pick_id:
			report_pick_execution(config, pick_id, trade, stake, price)
		else:
			print("[bot] pick created but no id returned; execution not logged")
	except Exception as exc:
		print("[bot] failed to log pick:", exc)
	state["bankroll"] = round(
		state.get("bankroll", config.paper_bankroll) - stake, 2
	)
	return True

def run_loop() -> None:
	config = load_config()
	if config.preflight_only:
		run_preflight(config)
		return
	state = load_state(config.state_path)
	now_init = int(time.time())
	placed_meta = normalize_placed_meta(state, now_init)
	placed_meta = prune_placed_meta(
		placed_meta,
		now_init,
		config.placed_ttl_seconds,
		config.placed_event_grace_seconds,
	)
	placed_group_meta = normalize_placed_group_meta(state, now_init)
	placed_group_meta = prune_placed_group_meta(
		placed_group_meta,
		now_init,
		config.placed_ttl_seconds,
		config.placed_event_grace_seconds,
	)
	placed = set(placed_meta.keys())
	placed_groups = set(placed_group_meta.keys())
	if "bankroll" not in state:
		state["bankroll"] = config.paper_bankroll

	window_start = parse_time_window(config.run_window_start)
	window_end = parse_time_window(config.run_window_end)
	call_timestamps: List[float] = []
	backoff = 0.0

	while True:
		try:
			if window_start and window_end:
				now_components = get_local_time_components(config.run_window_tz)
				if now_components:
					if not is_within_window(
						now_components[0],
						now_components[1],
						window_start,
						window_end,
					):
						sleep_seconds = apply_jitter(config.poll_seconds, config.poll_jitter_ratio)
						print("[bot] outside run window, sleeping", round(sleep_seconds, 1))
						time.sleep(sleep_seconds)
						continue

			now = time.time()
			placed_meta = prune_placed_meta(
				placed_meta,
				int(now),
				config.placed_ttl_seconds,
				config.placed_event_grace_seconds,
			)
			placed_group_meta = prune_placed_group_meta(
				placed_group_meta,
				int(time.time()),
				config.placed_ttl_seconds,
				config.placed_event_grace_seconds,
			)
			placed = set(placed_meta.keys())
			placed_groups = set(placed_group_meta.keys())
			call_timestamps = [t for t in call_timestamps if now - t < 3600]
			if config.max_calls_per_hour > 0 and len(call_timestamps) >= config.max_calls_per_hour:
				sleep_seconds = apply_jitter(config.poll_seconds, config.poll_jitter_ratio)
				print("[bot] rate cap reached, sleeping", round(sleep_seconds, 1))
				time.sleep(sleep_seconds)
				continue

			if backoff > 0:
				sleep_seconds = apply_jitter(backoff, config.poll_jitter_ratio)
				print("[bot] backoff", round(sleep_seconds, 1), "seconds")
				time.sleep(sleep_seconds)
				backoff = 0.0

			print(
				"[bot] polling",
				config.base_url,
				"window",
				config.window_minutes,
				"minToStart",
				config.min_minutes_to_start,
				"maxToStart",
				config.max_minutes_to_start,
				"minGrade",
				config.min_grade,
				"includeStarted",
				config.include_started,
			)
			call_timestamps.append(time.time())
			candidates, candidate_debug = fetch_candidates(config)
			print("[bot] candidates", len(candidates))
			if len(candidates) == 0 and isinstance(candidate_debug, dict):
				excluded = candidate_debug.get("excluded") or {}
				total_entries = candidate_debug.get("totalEntries")
				upcoming_entries = candidate_debug.get("upcomingEntries")
				log_event(
					"candidate_debug",
					totalEntries=total_entries,
					upcomingEntries=upcoming_entries,
					excluded=excluded,
					dedupDropped=candidate_debug.get("dedupDropped"),
					dedupReasons=candidate_debug.get("dedupReasons"),
				)
			new_bets = 0
			skipped_already_placed = 0
			skipped_missing_condition = 0
			skipped_timing_window = 0
			for idx, candidate in enumerate(candidates, start=1):
				entry = candidate.get("entry") or {}
				condition_id = entry.get("conditionId")
				log_event(
					"candidate",
					idx=idx,
					**candidate_context(candidate),
				)
				if not condition_id:
					skipped_missing_condition += 1
					log_event(
						"candidate_skip_missing_condition_id",
						idx=idx,
						**candidate_context(candidate),
					)
					continue
				if condition_id in placed:
					skipped_already_placed += 1
					placed_row = placed_meta.get(condition_id) or {}
					log_event(
						"candidate_skip_already_placed",
						idx=idx,
						placedAt=placed_row.get("placedAt"),
						placedEventTime=placed_row.get("eventTime"),
						**candidate_context(candidate),
					)
					continue
				market_group_key = get_market_group_key(entry)
				if market_group_key and market_group_key in placed_groups:
					skipped_already_placed += 1
					placed_group_row = placed_group_meta.get(market_group_key) or {}
					log_event(
						"candidate_skip_already_placed_group",
						idx=idx,
						placedAt=placed_group_row.get("placedAt"),
						placedEventTime=placed_group_row.get("eventTime"),
						placedConditionId=placed_group_row.get("conditionId"),
						**candidate_context(candidate),
					)
					continue
				minutes_until_start = minutes_to_start(entry.get("eventTime"))
				if minutes_until_start is None:
					skipped_timing_window += 1
					log_event(
						"candidate_skip_missing_event_time",
						idx=idx,
						**candidate_context(candidate),
					)
					continue
				if (
					minutes_until_start < config.min_minutes_to_start
					or minutes_until_start > config.max_minutes_to_start
				):
					skipped_timing_window += 1
					log_event(
						"candidate_skip_timing_window",
						idx=idx,
						minMinutes=config.min_minutes_to_start,
						maxMinutes=config.max_minutes_to_start,
						minutesToStart=minutes_until_start,
						**candidate_context(candidate),
					)
					continue
				log_event(
					"candidate_considering",
					idx=idx,
					**candidate_context(candidate),
				)
				did_place = place_bet(candidate, config, state)
				if did_place:
					placed.add(condition_id)
					placed_meta[condition_id] = {
						"placedAt": int(time.time()),
						"eventTime": entry.get("eventTime"),
					}
					if market_group_key:
						placed_groups.add(market_group_key)
						placed_group_meta[market_group_key] = {
							"placedAt": int(time.time()),
							"eventTime": entry.get("eventTime"),
							"conditionId": condition_id,
						}
					new_bets += 1
					if new_bets >= config.max_bets:
						print("[bot] max bets reached", config.max_bets)
						break
			log_event(
				"poll_summary",
				raw=len(candidates),
				skippedAlreadyPlaced=skipped_already_placed,
				skippedMissingConditionId=skipped_missing_condition,
				skippedTimingWindow=skipped_timing_window,
				newPlaced=new_bets,
			)
			state["placed"] = sorted(placed)
			state["placedMeta"] = placed_meta
			state["placedGroups"] = sorted(placed_groups)
			state["placedGroupMeta"] = placed_group_meta
			save_state(config.state_path, state)
		except Exception as exc:
			print("[bot] error:", exc)
			if config.poll_backoff_base > 0:
				backoff = min(
					config.poll_backoff_max,
					backoff * 2 if backoff else config.poll_backoff_base,
				)
		sleep_seconds = apply_jitter(config.poll_seconds, config.poll_jitter_ratio)
		time.sleep(sleep_seconds)


if __name__ == "__main__":
	run_loop()

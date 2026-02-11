import inspect
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
	require_microstructure: bool
	market_quality_threshold: float
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


def load_config() -> BotConfig:
	load_dotenv(os.getenv("BOT_ENV_PATH", "bot/.env"))
	base_url = os.getenv("BOT_BASE_URL", "").rstrip("/")
	api_key = os.getenv("BOT_API_KEY", "")
	base_url = _prompt_missing(base_url, "BOT_BASE_URL")
	api_key = _prompt_missing(api_key, "BOT_API_KEY", secret=True)
	if not base_url or not api_key:
		raise RuntimeError("BOT_BASE_URL and BOT_API_KEY are required")
	dry_run = os.getenv("BOT_DRY_RUN", "true").lower() != "false"
	poly_api_key = os.getenv("POLY_API_KEY", "")
	poly_api_secret = os.getenv("POLY_API_SECRET", "")
	poly_api_passphrase = os.getenv("POLY_API_PASSPHRASE", "")
	poly_private_key = os.getenv("POLY_PRIVATE_KEY", "")
	poly_funder = os.getenv("POLY_FUNDER", "")
	poly_signature_type = int(os.getenv("POLY_SIGNATURE_TYPE", "0"))
	poly_chain_id = int(os.getenv("POLY_CHAIN_ID", "137"))
	poly_clob_host = os.getenv("POLY_CLOB_HOST", "https://clob.polymarket.com")
	preflight_only = os.getenv("BOT_PREFLIGHT", "false").lower() == "true"
	preflight_condition_id = os.getenv("BOT_PREFLIGHT_CONDITION_ID", "").strip()
	poly_usdc_token = os.getenv(
		"POLY_USDC_TOKEN", "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
	)
	poly_conditional_token = os.getenv(
		"POLY_CONDITIONAL_TOKEN", "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
	)
	low_roi_threshold = float(os.getenv("BOT_LOW_ROI_THRESHOLD", "0.72"))
	stop_on_403 = os.getenv("BOT_STOP_ON_403", "true").lower() != "false"
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
		require_microstructure=os.getenv("BOT_REQUIRE_MICROSTRUCTURE", "false").lower()
		== "true",
		market_quality_threshold=float(
			os.getenv("BOT_MARKET_QUALITY_THRESHOLD", "0.72")
		),
		window_minutes=int(os.getenv("BOT_WINDOW_MINUTES", "5")),
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
			"minGrade": config.min_grade,
			"limit": str(config.max_bets * 3),
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

def log_event(event: str, **fields: Any) -> None:
	normalized: Dict[str, Any] = {}
	for key, value in fields.items():
		if isinstance(value, float):
			normalized[key] = round(value, 6)
		else:
			normalized[key] = value
	print(
		"[bot]",
		event,
		json.dumps(normalized, ensure_ascii=True, separators=(",", ":"), sort_keys=True),
	)

def candidate_context(candidate: Dict[str, Any]) -> Dict[str, Any]:
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
		"event": event_label,
		"eventTime": entry.get("eventTime"),
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
		from py_clob_client.client import ClobClient
	except Exception as exc:
		raise RuntimeError("py-clob-client not installed") from exc
	client = ClobClient(
		config.poly_clob_host,
		key=config.poly_private_key,
		chain_id=config.poly_chain_id,
		signature_type=config.poly_signature_type,
		funder=config.poly_funder or None,
	)
	if config.poly_api_key and config.poly_api_secret and config.poly_api_passphrase:
		setter = getattr(client, "set_api_creds", None)
		if setter:
			try:
				sig = inspect.signature(setter)
				param_count = len(sig.parameters)
			except Exception:
				param_count = 2
			try:
				if param_count >= 3:
					setter(
						config.poly_api_key,
						config.poly_api_secret,
						config.poly_api_passphrase,
					)
				elif param_count == 2:
					setter(
						{
							"apiKey": config.poly_api_key,
							"apiSecret": config.poly_api_secret,
							"apiPassphrase": config.poly_api_passphrase,
						}
					)
				else:
					setter()
			except Exception:
				client.set_api_creds(client.create_or_derive_api_creds())
		else:
			client.set_api_creds(client.create_or_derive_api_creds())
	else:
		client.set_api_creds(client.create_or_derive_api_creds())
	if getattr(client, "api_creds", None) is None:
		client.set_api_creds(client.create_or_derive_api_creds())
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
			from py_clob_client.clob_types import BalanceAllowanceParams, AssetType

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
	from py_clob_client.clob_types import MarketOrderArgs, OrderType
	from py_clob_client.order_builder.constants import BUY
	client = build_clob_client(config)
	order = MarketOrderArgs(
		token_id=token_id,
		amount=float(stake),
		side=BUY,
		order_type=OrderType.FOK,
	)
	signed = client.create_market_order(order)
	response = client.post_order(signed, OrderType.FOK)
	return {"token_id": token_id, "response": response}

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
		post_json(
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
			},
		)
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
	placed = set(placed_meta.keys())
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
			placed = set(placed_meta.keys())
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
				"minGrade",
				config.min_grade,
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
			for idx, candidate in enumerate(candidates, start=1):
				entry = candidate.get("entry") or {}
				condition_id = entry.get("conditionId")
				log_event("candidate", idx=idx, **candidate_context(candidate))
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
					new_bets += 1
					if new_bets >= config.max_bets:
						print("[bot] max bets reached", config.max_bets)
						break
			log_event(
				"poll_summary",
				raw=len(candidates),
				skippedAlreadyPlaced=skipped_already_placed,
				skippedMissingConditionId=skipped_missing_condition,
				newPlaced=new_bets,
			)
			state["placed"] = sorted(placed)
			state["placedMeta"] = placed_meta
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

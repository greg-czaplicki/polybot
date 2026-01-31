import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, List


@dataclass
class BotConfig:
	base_url: str
	api_key: str
	min_grade: str
	window_minutes: int
	poll_seconds: int
	max_bets: int
	dry_run: bool
	state_path: str
	poly_api_key: str
	poly_api_secret: str
	poly_api_passphrase: str
	paper_bankroll: float
	kelly_fraction: float
	max_stake: float
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
	poly_api_key = _prompt_missing(os.getenv("POLY_API_KEY", ""), "POLY_API_KEY", secret=True)
	poly_api_secret = _prompt_missing(
		os.getenv("POLY_API_SECRET", ""), "POLY_API_SECRET", secret=True
	)
	poly_api_passphrase = _prompt_missing(
		os.getenv("POLY_API_PASSPHRASE", ""), "POLY_API_PASSPHRASE", secret=True
	)
	return BotConfig(
		base_url=base_url,
		api_key=api_key,
		min_grade=os.getenv("BOT_MIN_GRADE", "A"),
		window_minutes=int(os.getenv("BOT_WINDOW_MINUTES", "5")),
		poll_seconds=int(os.getenv("BOT_POLL_SECONDS", "20")),
		max_bets=int(os.getenv("BOT_MAX_BETS", "5")),
		dry_run=os.getenv("BOT_DRY_RUN", "true").lower() != "false",
		state_path=os.getenv("BOT_STATE_PATH", "bot/state.json"),
		poly_api_key=poly_api_key,
		poly_api_secret=poly_api_secret,
		poly_api_passphrase=poly_api_passphrase,
		paper_bankroll=float(os.getenv("BOT_PAPER_BANKROLL", "1000")),
		kelly_fraction=float(os.getenv("BOT_KELLY_FRACTION", "0.25")),
		max_stake=float(os.getenv("BOT_MAX_STAKE", "50")),
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


def fetch_candidates(config: BotConfig) -> List[Dict[str, Any]]:
	query = urllib.parse.urlencode(
		{
			"windowMinutes": str(config.window_minutes),
			"minGrade": config.min_grade,
			"limit": str(config.max_bets * 3),
		}
	)
	url = f"{config.base_url}/api/bot/candidates?{query}"
	data = request_json(url, config.api_key)
	return data.get("candidates", [])

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
) -> float:
	entry = candidate["entry"]
	grade = candidate["grade"]
	grade_label = grade.get("grade", "D")
	price = entry.get("sharpSidePrice")
	if price is None:
		print("[bot] skip missing price", entry.get("marketTitle"))
		return state.get("bankroll", config.paper_bankroll)

	prob = GRADE_PROB_DEFAULTS.get(grade_label, 0.50)
	kelly = kelly_fraction(prob, float(price))
	stake = state.get("bankroll", config.paper_bankroll) * kelly * config.kelly_fraction
	stake = min(stake, config.max_stake)
	if stake < 1:
		print("[bot] skip tiny stake", entry.get("marketTitle"), "stake", stake)
		return state.get("bankroll", config.paper_bankroll)

	trade = {
		"timestamp": int(time.time()),
		"conditionId": entry.get("conditionId"),
		"marketTitle": entry.get("marketTitle"),
		"sharpSide": entry.get("sharpSide"),
		"price": price,
		"grade": grade_label,
		"signalScore": grade.get("signalScore"),
		"stake": round(stake, 2),
		"mode": "paper",
	}

	if config.dry_run:
		print(
			"[paper] bet",
			entry.get("marketTitle"),
			entry.get("sharpSide"),
			"grade",
			grade_label,
			"stake",
			round(stake, 2),
		)
	else:
		print("[bot] real trading not implemented; defaulting to paper")

	append_trade_log(config.trade_log_path, trade)
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
	return state["bankroll"]

def run_loop() -> None:
	config = load_config()
	state = load_state(config.state_path)
	placed = set(state.get("placed", []))
	if "bankroll" not in state:
		state["bankroll"] = config.paper_bankroll

	while True:
		try:
			print(
				"[bot] polling",
				config.base_url,
				"window",
				config.window_minutes,
				"minGrade",
				config.min_grade,
			)
			candidates = fetch_candidates(config)
			print("[bot] candidates", len(candidates))
			new_bets = 0
			for candidate in candidates:
				entry = candidate.get("entry") or {}
				condition_id = entry.get("conditionId")
				if not condition_id:
					continue
				if condition_id in placed:
					print("[bot] skip already placed", condition_id)
					continue
				print(
					"[bot] considering",
					entry.get("marketTitle"),
					entry.get("sharpSide"),
					"grade",
					(candidate.get("grade") or {}).get("grade"),
				)
				place_bet(candidate, config, state)
				placed.add(condition_id)
				new_bets += 1
				if new_bets >= config.max_bets:
					print("[bot] max bets reached", config.max_bets)
					break
			state["placed"] = sorted(placed)
			save_state(config.state_path, state)
		except Exception as exc:
			print("[bot] error:", exc)
		time.sleep(config.poll_seconds)


if __name__ == "__main__":
	run_loop()

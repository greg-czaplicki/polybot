#!/usr/bin/env python3
import json
import os
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.error
import urllib.request
from typing import Dict, List, Tuple
from urllib.parse import parse_qs, urlparse

SERVICE_NAME = os.environ.get("BOT_SERVICE_NAME", "polywhaler-bot")
CONTROL_TOKEN = os.environ.get("CONTROL_TOKEN", "")
CONTROL_BIND = os.environ.get("CONTROL_BIND", "127.0.0.1")
CONTROL_PORT = int(os.environ.get("CONTROL_PORT", "9102"))
CONTROL_LOG_LINES_DEFAULT = int(os.environ.get("CONTROL_LOG_LINES_DEFAULT", "200"))
CONTROL_LOG_LINES_MAX = int(os.environ.get("CONTROL_LOG_LINES_MAX", "1000"))
CONTROL_ENV_FILE = os.environ.get("CONTROL_ENV_FILE", "")
# OddsPapi relay (2026-08-28): oddspapi.io blocks Cloudflare Workers egress
# IPs ("RESTRICTED_ACCESS: Your IP address has been blocked"), so the app's
# Pinnacle sweep calls OddsPapi through this agent. Pure pass-through of an
# allowlisted path + query (the app supplies apiKey in the query); the
# response status/body are returned verbatim. Auth = the control token.
ODDSPAPI_UPSTREAM = os.environ.get("ODDSPAPI_UPSTREAM", "https://api.oddspapi.io")
ODDSPAPI_ALLOWED_PATHS = {
	"/v4/account",
	"/v4/sports",
	"/v4/tournaments",
	"/v4/markets",
	"/v4/odds-by-tournaments",
	"/v4/fixtures",
	"/v4/fixture",
	"/v4/odds",
	"/v4/historical-odds",
}
ODDSPAPI_TIMEOUT_SECONDS = int(os.environ.get("ODDSPAPI_TIMEOUT_SECONDS", "60"))
CONTROL_ENV_ALLOWLIST = {
	key.strip()
	for key in os.environ.get("CONTROL_ENV_ALLOWLIST", "").split(",")
	if key.strip()
}


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict) -> None:
	data = json.dumps(payload).encode("utf-8")
	handler.send_response(status)
	handler.send_header("Content-Type", "application/json")
	handler.send_header("Cache-Control", "no-store")
	handler.send_header("Content-Length", str(len(data)))
	handler.end_headers()
	handler.wfile.write(data)


def require_auth(handler: BaseHTTPRequestHandler) -> bool:
	auth_header = handler.headers.get("Authorization", "")
	token = ""
	if auth_header.lower().startswith("bearer "):
		token = auth_header[7:].strip()
	else:
		token = handler.headers.get("X-Control-Token", "")
	return bool(CONTROL_TOKEN) and token == CONTROL_TOKEN


def run_command(args: List[str]) -> Tuple[int, str, str]:
	process = subprocess.run(
		args,
		text=True,
		capture_output=True,
	)
	return process.returncode, process.stdout, process.stderr


def get_status() -> dict:
	code, stdout, stderr = run_command(
		[
			"systemctl",
			"show",
			SERVICE_NAME,
			"--no-page",
			"-p",
			"ActiveState",
			"-p",
			"SubState",
			"-p",
			"ExecMainStatus",
			"-p",
			"MainPID",
			"-p",
			"ExecMainStartTimestamp",
		],
	)
	if code != 0:
		return {"service": SERVICE_NAME, "error": stderr.strip() or "status_failed"}
	payload: Dict[str, str] = {}
	for line in stdout.splitlines():
		if "=" not in line:
			continue
		key, value = line.split("=", 1)
		payload[key] = value
	return {
		"service": SERVICE_NAME,
		"activeState": payload.get("ActiveState", "unknown"),
		"subState": payload.get("SubState", "unknown"),
		"execMainStatus": int(payload.get("ExecMainStatus") or 0),
		"mainPid": int(payload.get("MainPID") or 0) or None,
		"startedAt": payload.get("ExecMainStartTimestamp") or None,
	}


def clamp_log_lines(value: int) -> int:
	if value <= 0:
		return CONTROL_LOG_LINES_DEFAULT
	return min(value, CONTROL_LOG_LINES_MAX)


def read_env_file(path: str) -> Dict[str, str]:
	result: Dict[str, str] = {}
	if not path or not os.path.exists(path):
		return result
	with open(path, "r", encoding="utf-8") as handle:
		for line in handle:
			stripped = line.strip()
			if not stripped or stripped.startswith("#") or "=" not in stripped:
				continue
			key, value = stripped.split("=", 1)
			key = key.strip()
			value = value.strip()
			if (value.startswith('"') and value.endswith('"')) or (
				value.startswith("'") and value.endswith("'")
			):
				value = value[1:-1]
			if key in CONTROL_ENV_ALLOWLIST:
				result[key] = value
	return result


def serialize_env_value(value: str) -> str:
	if value == "":
		return '""'
	needs_quotes = any(ch.isspace() for ch in value) or "#" in value or "=" in value
	if not needs_quotes:
		return value
	escaped = value.replace("\\", "\\\\").replace('"', '\\"')
	return f'"{escaped}"'


def update_env_file(path: str, updates: Dict[str, str]) -> Dict[str, str]:
	if not path:
		raise ValueError("env_file_not_configured")
	lines: List[str] = []
	if os.path.exists(path):
		with open(path, "r", encoding="utf-8") as handle:
			lines = handle.readlines()
	found = set()
	for index, line in enumerate(lines):
		stripped = line.strip()
		if not stripped or stripped.startswith("#") or "=" not in stripped:
			continue
		key, _value = stripped.split("=", 1)
		key = key.strip()
		if key in updates:
			lines[index] = f"{key}={serialize_env_value(updates[key])}\n"
			found.add(key)
	for key, value in updates.items():
		if key not in found:
			lines.append(f"{key}={serialize_env_value(value)}\n")
	with tempfile.NamedTemporaryFile("w", delete=False, encoding="utf-8") as handle:
		handle.writelines(lines)
		temp_path = handle.name
	os.replace(temp_path, path)
	return read_env_file(path)


def relay_oddspapi(handler: BaseHTTPRequestHandler, subpath: str, raw_query: str) -> None:
	if subpath not in ODDSPAPI_ALLOWED_PATHS:
		return json_response(handler, 404, {"error": "oddspapi_path_not_allowed"})
	url = f"{ODDSPAPI_UPSTREAM}{subpath}" + (f"?{raw_query}" if raw_query else "")
	request = urllib.request.Request(
		url,
		headers={"Accept": "application/json", "User-Agent": "polywhaler-relay/1.0"},
	)
	try:
		with urllib.request.urlopen(request, timeout=ODDSPAPI_TIMEOUT_SECONDS) as response:
			status = response.status
			content_type = response.headers.get("Content-Type", "application/json")
			data = response.read()
	except urllib.error.HTTPError as exc:
		status = exc.code
		content_type = (exc.headers.get("Content-Type") if exc.headers else None) or "application/json"
		data = exc.read()
	except Exception as exc:  # network / timeout
		return json_response(
			handler, 502, {"error": "oddspapi_upstream_failed", "details": str(exc)[:200]}
		)
	handler.send_response(status)
	handler.send_header("Content-Type", content_type)
	handler.send_header("Cache-Control", "no-store")
	handler.send_header("Content-Length", str(len(data)))
	handler.end_headers()
	handler.wfile.write(data)


class ControlHandler(BaseHTTPRequestHandler):
	def do_GET(self) -> None:
		if not require_auth(self):
			return json_response(self, 401, {"error": "unauthorized"})

		parsed = urlparse(self.path)
		path = parsed.path
		query = parse_qs(parsed.query)

		if path == "/status":
			return json_response(self, 200, get_status())

		if path.startswith("/oddspapi/"):
			return relay_oddspapi(self, path[len("/oddspapi") :], parsed.query)

		if path == "/logs":
			lines = clamp_log_lines(int(query.get("lines", [CONTROL_LOG_LINES_DEFAULT])[0]))
			code, stdout, stderr = run_command(
				[
					"journalctl",
					"-u",
					SERVICE_NAME,
					"-n",
					str(lines),
					"--no-pager",
					"-o",
					"short-iso",
				],
			)
			if code != 0:
				return json_response(self, 500, {"error": stderr.strip() or "logs_failed"})
			return json_response(self, 200, {"lines": [line for line in stdout.splitlines()]})

		if path == "/logs/stream":
			lines = clamp_log_lines(int(query.get("lines", [CONTROL_LOG_LINES_DEFAULT])[0]))
			self.send_response(200)
			self.send_header("Content-Type", "text/event-stream")
			self.send_header("Cache-Control", "no-store")
			self.send_header("Connection", "keep-alive")
			self.send_header("X-Accel-Buffering", "no")
			self.end_headers()
			process = subprocess.Popen(
				[
					"journalctl",
					"-u",
					SERVICE_NAME,
					"-n",
					str(lines),
					"-f",
					"--no-pager",
					"-o",
					"short-iso",
				],
				stdout=subprocess.PIPE,
				stderr=subprocess.PIPE,
				text=True,
			)
			try:
				assert process.stdout is not None
				for line in process.stdout:
					payload = f"data: {line.rstrip()}\n\n"
					self.wfile.write(payload.encode("utf-8"))
					self.wfile.flush()
			except BrokenPipeError:
				pass
			finally:
				process.terminate()
			return

		if path == "/env":
			if not CONTROL_ENV_FILE or not CONTROL_ENV_ALLOWLIST:
				return json_response(self, 404, {"error": "env_not_configured"})
			payload = read_env_file(CONTROL_ENV_FILE)
			return json_response(
				self,
				200,
				{
					"env": payload,
					"path": CONTROL_ENV_FILE,
					"allowlist": sorted(CONTROL_ENV_ALLOWLIST),
				},
			)

		return json_response(self, 404, {"error": "not_found"})

	def do_POST(self) -> None:
		if not require_auth(self):
			return json_response(self, 401, {"error": "unauthorized"})

		parsed = urlparse(self.path)
		path = parsed.path

		if path in ("/start", "/stop", "/restart"):
			action = path[1:]
			code, _stdout, stderr = run_command(["systemctl", action, SERVICE_NAME])
			if code != 0:
				return json_response(self, 500, {"error": stderr.strip() or "action_failed"})
			return json_response(self, 200, get_status())

		if path == "/env":
			if not CONTROL_ENV_FILE or not CONTROL_ENV_ALLOWLIST:
				return json_response(self, 404, {"error": "env_not_configured"})
			content_length = int(self.headers.get("Content-Length", "0") or "0")
			body = self.rfile.read(content_length).decode("utf-8")
			try:
				payload = json.loads(body) if body else {}
			except json.JSONDecodeError:
				return json_response(self, 400, {"error": "invalid_json"})
			updates = payload.get("updates", {})
			if not isinstance(updates, dict):
				return json_response(self, 400, {"error": "invalid_updates"})
			filtered = {
				key: str(value)
				for key, value in updates.items()
				if key in CONTROL_ENV_ALLOWLIST
			}
			if not filtered:
				return json_response(self, 400, {"error": "no_allowed_updates"})
			try:
				env_payload = update_env_file(CONTROL_ENV_FILE, filtered)
			except Exception as exc:
				return json_response(self, 500, {"error": str(exc)})
			return json_response(
				self,
				200,
				{
					"env": env_payload,
					"path": CONTROL_ENV_FILE,
					"allowlist": sorted(CONTROL_ENV_ALLOWLIST),
				},
			)

		return json_response(self, 404, {"error": "not_found"})

	def log_message(self, format: str, *args) -> None:
		return


def main() -> None:
	if not CONTROL_TOKEN:
		raise SystemExit("CONTROL_TOKEN is required")
	server = ThreadingHTTPServer((CONTROL_BIND, CONTROL_PORT), ControlHandler)
	print(f"control-agent listening on {CONTROL_BIND}:{CONTROL_PORT}")
	server.serve_forever()


if __name__ == "__main__":
	main()

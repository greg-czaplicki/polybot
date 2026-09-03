import { createFileRoute } from "@tanstack/react-router";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import {
	type FormEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import { Shell } from "@/components/terminal/shell";

export const Route = createFileRoute("/bot")({
	component: BotPage,
});

type BotStatus = {
	service: string;
	activeState: string;
	subState: string;
	mainPid?: number | null;
	execMainStatus?: number | null;
	startedAt?: string | null;
};

type EnvPayload = {
	env: Record<string, string>;
	path?: string;
	allowlist?: string[];
};

type LogEntry = {
	id: number;
	line: string;
};

type ActionKey = "start" | "stop" | "restart";

const SECRET_KEY_PATTERN =
	/(^|_)(SECRET|PASSWORD|PASSPHRASE|TOKEN|KEY|PRIVATE|APIKEY)s?($|_)/i;

function isSecretKey(key: string): boolean {
	return SECRET_KEY_PATTERN.test(key);
}

function getAuthToken(): string | null {
	if (typeof window === "undefined") return null;
	return localStorage.getItem("polywhaler_auth_token");
}

function BotPage() {
	const [status, setStatus] = useState<BotStatus | null>(null);
	const [statusError, setStatusError] = useState<string | null>(null);
	const [statusLoading, setStatusLoading] = useState(false);
	const [actionLoading, setActionLoading] = useState<ActionKey | null>(null);
	const [logs, setLogs] = useState<LogEntry[]>([]);
	const [logsError, setLogsError] = useState<string | null>(null);
	const [logsLoading, setLogsLoading] = useState(false);
	const [isStreaming, setIsStreaming] = useState(false);
	const [streamError, setStreamError] = useState<string | null>(null);
	const [envPayload, setEnvPayload] = useState<EnvPayload | null>(null);
	const [envEdits, setEnvEdits] = useState<Record<string, string>>({});
	const [envLoading, setEnvLoading] = useState(false);
	const [envSaving, setEnvSaving] = useState(false);
	const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(
		new Set(),
	);

	const streamAbortRef = useRef<AbortController | null>(null);
	const initialLoadTokenRef = useRef<string | null>(null);
	const logIdRef = useRef(0);
	const logsContainerRef = useRef<HTMLDivElement>(null);
	const logsNearBottomRef = useRef(true);

	const authToken = getAuthToken();
	const authHeaderValue = useMemo(
		() => (authToken ? `Bearer ${authToken}` : null),
		[authToken],
	);

	const canAuthed = useMemo(() => Boolean(authHeaderValue), [authHeaderValue]);

	const getRequestHeaders = useCallback(
		(extra?: HeadersInit) => {
			if (!authHeaderValue) return extra;
			return {
				Authorization: authHeaderValue,
				...(extra ?? {}),
			};
		},
		[authHeaderValue],
	);

	const appendLogLines = useCallback((lines: string[]) => {
		if (!lines.length) return;
		setLogs((prev) => {
			const appended = lines.map((line) => ({
				id: logIdRef.current++,
				line,
			}));
			const next = [...prev, ...appended];
			if (next.length > 2000) {
				return next.slice(next.length - 2000);
			}
			return next;
		});
	}, []);

	const replaceLogLines = useCallback((lines: string[]) => {
		logIdRef.current = 0;
		setLogs(lines.map((line) => ({ id: logIdRef.current++, line })));
	}, []);

	const loadStatus = useCallback(async () => {
		if (!authHeaderValue) return;
		setStatusLoading(true);
		setStatusError(null);
		try {
			const response = await fetch("/api/bot-control/status", {
				headers: getRequestHeaders(),
			});
			if (!response.ok) {
				throw new Error(`Status failed (${response.status})`);
			}
			const payload = (await response.json()) as BotStatus;
			setStatus(payload);
		} catch (error) {
			setStatusError(
				error instanceof Error ? error.message : "Failed to load status",
			);
		} finally {
			setStatusLoading(false);
		}
	}, [authHeaderValue, getRequestHeaders]);

	const runAction = useCallback(
		async (action: ActionKey) => {
			if (action === "stop") {
				if (!confirm("Stop the bot? Any in-flight bets may abort.")) return;
			} else if (action === "restart") {
				if (!confirm("Restart the bot? The service will be briefly offline."))
					return;
			}
			setActionLoading(action);
			setStatusError(null);
			try {
				const response = await fetch(`/api/bot-control/${action}`, {
					method: "POST",
					headers: getRequestHeaders(),
				});
				if (!response.ok) {
					throw new Error(`Action failed (${response.status})`);
				}
				const payload = (await response.json()) as BotStatus;
				setStatus(payload);
			} catch (error) {
				setStatusError(
					error instanceof Error ? error.message : "Action failed",
				);
			} finally {
				setActionLoading(null);
			}
		},
		[getRequestHeaders],
	);

	const loadLogs = useCallback(async () => {
		if (!authHeaderValue) return;
		setLogsLoading(true);
		setLogsError(null);
		try {
			const response = await fetch("/api/bot-control/logs?lines=200", {
				headers: getRequestHeaders(),
			});
			if (!response.ok) {
				throw new Error(`Logs failed (${response.status})`);
			}
			const payload = (await response.json()) as { lines: string[] };
			replaceLogLines(payload.lines ?? []);
			logsNearBottomRef.current = true;
		} catch (error) {
			setLogsError(
				error instanceof Error ? error.message : "Failed to load logs",
			);
		} finally {
			setLogsLoading(false);
		}
	}, [authHeaderValue, getRequestHeaders, replaceLogLines]);

	const stopStream = useCallback(() => {
		if (streamAbortRef.current) {
			streamAbortRef.current.abort();
			streamAbortRef.current = null;
		}
		setIsStreaming(false);
	}, []);

	const startStream = useCallback(async () => {
		if (!authHeaderValue) {
			setStreamError("Missing auth token. Please log in again.");
			return;
		}
		stopStream();
		setStreamError(null);
		setIsStreaming(true);

		const controller = new AbortController();
		streamAbortRef.current = controller;

		try {
			const response = await fetch("/api/bot-control/logs/stream?lines=200", {
				headers: getRequestHeaders(),
				signal: controller.signal,
			});
			if (!response.ok || !response.body) {
				throw new Error(`Stream failed (${response.status})`);
			}
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				const newLines: string[] = [];
				for (const line of lines) {
					const trimmed = line.trimEnd();
					if (!trimmed) continue;
					if (trimmed.startsWith("data:")) {
						const content = trimmed.slice(5).trimStart();
						if (content) newLines.push(content);
					} else if (!trimmed.startsWith("event:")) {
						newLines.push(trimmed);
					}
				}
				if (newLines.length) appendLogLines(newLines);
			}
		} catch (error) {
			if (!controller.signal.aborted) {
				setStreamError(
					error instanceof Error ? error.message : "Stream failed",
				);
			}
		} finally {
			setIsStreaming(false);
		}
	}, [authHeaderValue, getRequestHeaders, stopStream, appendLogLines]);

	const loadEnv = useCallback(async () => {
		if (!authHeaderValue) return;
		setEnvLoading(true);
		try {
			const response = await fetch("/api/bot-control/env", {
				headers: getRequestHeaders(),
			});
			if (!response.ok) {
				throw new Error(`Env failed (${response.status})`);
			}
			const payload = (await response.json()) as EnvPayload;
			setEnvPayload(payload);
			setEnvEdits(payload.env ?? {});
			setRevealedSecrets(new Set());
		} catch (error) {
			console.error("Failed to load env", error);
		} finally {
			setEnvLoading(false);
		}
	}, [authHeaderValue, getRequestHeaders]);

	const dirtyKeys = useMemo(() => {
		if (!envPayload) return new Set<string>();
		const set = new Set<string>();
		for (const [key, value] of Object.entries(envEdits)) {
			if (envPayload.env[key] !== value) set.add(key);
		}
		return set;
	}, [envEdits, envPayload]);

	const saveEnv = useCallback(
		async (e?: FormEvent) => {
			if (e) e.preventDefault();
			if (!envPayload || dirtyKeys.size === 0) return;
			setEnvSaving(true);
			try {
				const updates: Record<string, string> = {};
				for (const key of dirtyKeys) {
					updates[key] = envEdits[key];
				}
				const response = await fetch("/api/bot-control/env", {
					method: "POST",
					headers: getRequestHeaders({
						"Content-Type": "application/json",
					}),
					body: JSON.stringify({ updates }),
				});
				if (!response.ok) {
					throw new Error(`Env save failed (${response.status})`);
				}
				const payload = (await response.json()) as EnvPayload;
				setEnvPayload(payload);
				setEnvEdits(payload.env ?? {});
			} catch (error) {
				console.error("Failed to save env", error);
			} finally {
				setEnvSaving(false);
			}
		},
		[dirtyKeys, envEdits, envPayload, getRequestHeaders],
	);

	const toggleReveal = useCallback((key: string) => {
		setRevealedSecrets((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	useEffect(() => {
		if (!authToken) return;
		if (initialLoadTokenRef.current === authToken) return;
		initialLoadTokenRef.current = authToken;
		void loadStatus();
		void loadLogs();
		void loadEnv();
		return () => {
			stopStream();
		};
	}, [authToken, loadStatus, loadLogs, loadEnv, stopStream]);

	// Auto-scroll logs to bottom only if user is already near the bottom.
	useEffect(() => {
		const el = logsContainerRef.current;
		if (!el) return;
		if (logsNearBottomRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, []);

	const handleLogsScroll = useCallback(() => {
		const el = logsContainerRef.current;
		if (!el) return;
		const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		logsNearBottomRef.current = distanceFromBottom < 80;
	}, []);

	return (
		<Shell wide>
			<div>
				<div className="mx-auto max-w-5xl space-y-6">
					{/* Header */}
					<div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
						<div>
							<h1 className="font-sans text-2xl font-semibold tracking-tight text-ink-95">
								Bot Control
							</h1>
							<p className="mt-0.5 font-sans text-sm text-ink-70">
								Manage the VPS bot service and inspect logs.
							</p>
						</div>
						<div className="flex flex-wrap gap-2">
							<button
								type="button"
								onClick={() => void loadStatus()}
								disabled={statusLoading}
								className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 font-mono text-xxs font-semibold uppercase tracking-wider text-ink-85 ring-1 ring-inset ring-ink-25 transition-colors hover:bg-ink-15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue disabled:opacity-40"
							>
								{statusLoading && <Loader2 className="h-3 w-3 animate-spin" />}
								{statusLoading ? "refreshing…" : "refresh status"}
							</button>
							<button
								type="button"
								onClick={() => void loadLogs()}
								disabled={logsLoading}
								className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 font-mono text-xxs font-semibold uppercase tracking-wider text-ink-85 ring-1 ring-inset ring-ink-25 transition-colors hover:bg-ink-15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue disabled:opacity-40"
							>
								{logsLoading && <Loader2 className="h-3 w-3 animate-spin" />}
								{logsLoading ? "loading…" : "reload logs"}
							</button>
						</div>
					</div>

					{!canAuthed && (
						// biome-ignore lint/a11y/useSemanticElements: role="status" on a div is the standard ARIA pattern for a transient notification region.
						<div
							role="status"
							className="rounded-md bg-signal-warn/10 px-4 py-3 text-sm text-signal-warn ring-1 ring-inset ring-signal-warn/30"
						>
							Authentication token missing. Log out and back in to enable bot
							controls.
						</div>
					)}

					<div className="grid gap-4 md:grid-cols-3">
						{/* Service Status */}
						<section
							aria-labelledby="bot-status-heading"
							className="space-y-4 rounded-md bg-ink-05 p-5 ring-1 ring-inset ring-ink-15 md:col-span-2"
						>
							<div className="flex items-baseline justify-between gap-2">
								<h2
									id="bot-status-heading"
									className="font-sans text-base font-semibold text-ink-95"
								>
									Service Status
								</h2>
								<span className="font-mono text-xxs tabular-nums text-ink-55">
									{status?.service ?? "polywhaler-bot"}
								</span>
							</div>

							{statusError && (
								<div
									role="alert"
									className="rounded-md bg-signal-bad/10 px-3 py-2 text-sm text-signal-bad ring-1 ring-inset ring-signal-bad/35"
								>
									{statusError}
								</div>
							)}

							<div className="grid gap-3 text-sm md:grid-cols-2">
								<StatusCell label="Active" value={status?.activeState} />
								<StatusCell label="Substate" value={status?.subState} />
								<StatusCell label="Main PID" value={status?.mainPid} />
								<StatusCell label="Exit Code" value={status?.execMainStatus} />
								<div className="md:col-span-2">
									<div className="font-mono text-xxs uppercase tracking-wider text-ink-55">
										Started
									</div>
									<div className="mt-0.5 font-mono text-sm tabular-nums text-ink-85">
										{status?.startedAt ?? "—"}
									</div>
								</div>
							</div>

							{/* biome-ignore lint/a11y/useSemanticElements: role="group" with
							    aria-label is the right ARIA pattern for a non-landmark control cluster. */}
							<div
								className="flex flex-wrap gap-2"
								role="group"
								aria-label="Bot service actions"
							>
								<ActionButton
									label="Start"
									loadingLabel="Starting…"
									isActive={actionLoading === "start"}
									isLocked={actionLoading !== null && actionLoading !== "start"}
									onClick={() => void runAction("start")}
								/>
								<ActionButton
									label="Stop"
									loadingLabel="Stopping…"
									tone="bad"
									isActive={actionLoading === "stop"}
									isLocked={actionLoading !== null && actionLoading !== "stop"}
									onClick={() => void runAction("stop")}
								/>
								<ActionButton
									label="Restart"
									loadingLabel="Restarting…"
									isActive={actionLoading === "restart"}
									isLocked={
										actionLoading !== null && actionLoading !== "restart"
									}
									onClick={() => void runAction("restart")}
								/>
							</div>
						</section>

						{/* Config */}
						<section
							aria-labelledby="bot-config-heading"
							className="space-y-3 rounded-md bg-ink-05 p-5 ring-1 ring-inset ring-ink-15"
						>
							<h2
								id="bot-config-heading"
								className="font-sans text-base font-semibold text-ink-95"
							>
								Config
							</h2>

							{envLoading && (
								<div className="font-mono text-xs text-ink-55">
									Loading env…
								</div>
							)}

							{!envLoading && envPayload && (
								<form onSubmit={saveEnv} className="space-y-3">
									{envPayload.path && (
										<div className="break-all font-mono text-xxs text-ink-55">
											File: {envPayload.path}
										</div>
									)}
									<div className="max-h-64 space-y-2 overflow-auto pr-1 md:max-h-[50vh]">
										{Object.entries(envEdits).map(([key, value]) => {
											const secret = isSecretKey(key);
											const revealed = revealedSecrets.has(key);
											const masked = secret && !revealed;
											const isDirty = dirtyKeys.has(key);
											return (
												<div key={key} className="space-y-1">
													<div className="flex items-center justify-between gap-2">
														<label
															htmlFor={`env-${key}`}
															className="font-mono text-xxs uppercase tracking-wider text-ink-55"
														>
															{key}
															{isDirty && (
																<>
																	<span
																		className="ml-1 text-brand-blue"
																		aria-hidden
																	>
																		●
																	</span>
																	<span className="sr-only">
																		{" "}
																		unsaved change
																	</span>
																</>
															)}
														</label>
														{secret && (
															<button
																type="button"
																onClick={() => toggleReveal(key)}
																aria-label={
																	revealed ? `Hide ${key}` : `Reveal ${key}`
																}
																aria-pressed={revealed}
																className="inline-flex h-5 w-5 items-center justify-center rounded text-ink-55 transition-colors hover:bg-ink-15 hover:text-ink-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue"
															>
																{revealed ? (
																	<EyeOff className="h-3 w-3" />
																) : (
																	<Eye className="h-3 w-3" />
																)}
															</button>
														)}
													</div>
													<input
														id={`env-${key}`}
														type={masked ? "password" : "text"}
														autoComplete="off"
														spellCheck={false}
														value={value}
														onChange={(event) =>
															setEnvEdits((prev) => ({
																...prev,
																[key]: event.target.value,
															}))
														}
														className={`w-full rounded-md bg-ink-00 px-2 py-1 font-mono text-sm text-ink-95 ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue ${
															isDirty ? "ring-brand-blue/40" : "ring-ink-25"
														}`}
													/>
												</div>
											);
										})}
									</div>
									<button
										type="submit"
										disabled={envSaving || dirtyKeys.size === 0}
										className={`inline-flex h-9 w-full items-center justify-center gap-2 rounded-md px-3 font-mono text-xxs font-semibold uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue disabled:opacity-40 ${
											dirtyKeys.size > 0
												? "bg-brand-blue text-ink-00 hover:brightness-110"
												: "text-ink-55 ring-1 ring-inset ring-ink-25"
										}`}
									>
										{envSaving && <Loader2 className="h-3 w-3 animate-spin" />}
										{envSaving
											? "saving…"
											: dirtyKeys.size > 0
												? `save env (${dirtyKeys.size} changed)`
												: "no changes"}
									</button>
								</form>
							)}

							{!envLoading && !envPayload && (
								<div className="font-mono text-xs text-ink-55">
									Env editing is not configured.
								</div>
							)}
						</section>
					</div>

					{/* Logs */}
					<section
						aria-labelledby="bot-logs-heading"
						className="space-y-4 rounded-md bg-ink-05 p-5 ring-1 ring-inset ring-ink-15"
					>
						<div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
							<h2
								id="bot-logs-heading"
								className="font-sans text-base font-semibold text-ink-95"
							>
								Logs
							</h2>
							<div className="flex gap-2">
								<button
									type="button"
									onClick={() => void startStream()}
									disabled={isStreaming}
									className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 font-mono text-xxs font-semibold uppercase tracking-wider text-ink-85 ring-1 ring-inset ring-ink-25 transition-colors hover:bg-ink-15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue disabled:opacity-40"
								>
									{isStreaming && (
										<span
											className="h-2 w-2 animate-pulse rounded-full bg-brand-blue"
											aria-hidden
										/>
									)}
									{isStreaming ? "streaming" : "start stream"}
								</button>
								<button
									type="button"
									onClick={stopStream}
									disabled={!isStreaming}
									className="inline-flex h-8 items-center rounded-md px-3 font-mono text-xxs font-semibold uppercase tracking-wider text-ink-85 ring-1 ring-inset ring-ink-25 transition-colors hover:bg-ink-15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue disabled:opacity-40"
								>
									stop stream
								</button>
							</div>
						</div>

						{logsError && (
							<div
								role="alert"
								className="rounded-md bg-signal-bad/10 px-3 py-2 text-sm text-signal-bad ring-1 ring-inset ring-signal-bad/35"
							>
								{logsError}
							</div>
						)}
						{streamError && (
							<div
								role="alert"
								className="rounded-md bg-signal-warn/10 px-3 py-2 text-sm text-signal-warn ring-1 ring-inset ring-signal-warn/30"
							>
								{streamError}
							</div>
						)}

						<div
							ref={logsContainerRef}
							onScroll={handleLogsScroll}
							role="log"
							aria-label="Bot service logs"
							aria-live="off"
							className="max-h-96 overflow-auto rounded-md bg-ink-00 p-3 font-mono text-xs text-ink-85 md:max-h-[60vh]"
						>
							{logs.length === 0 ? (
								<div className="text-ink-55">No logs yet.</div>
							) : (
								logs.map((entry) => (
									<div key={entry.id} className="whitespace-pre-wrap">
										{entry.line || " "}
									</div>
								))
							)}
						</div>
					</section>
				</div>
			</div>
		</Shell>
	);
}

function StatusCell({
	label,
	value,
}: {
	label: string;
	value: string | number | null | undefined;
}) {
	return (
		<div>
			<div className="font-mono text-xxs uppercase tracking-wider text-ink-55">
				{label}
			</div>
			<div className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-ink-95">
				{value ?? "—"}
			</div>
		</div>
	);
}

function ActionButton({
	label,
	loadingLabel,
	tone,
	isActive,
	isLocked,
	onClick,
}: {
	label: string;
	loadingLabel: string;
	tone?: "bad";
	isActive: boolean;
	isLocked: boolean;
	onClick: () => void;
}) {
	const hoverTone =
		tone === "bad"
			? "hover:bg-signal-bad/10 hover:text-signal-bad hover:ring-signal-bad/35"
			: "hover:bg-ink-15 hover:text-ink-95";
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={isActive || isLocked}
			className={`inline-flex h-9 items-center gap-1.5 rounded-md px-3 font-mono text-xs font-semibold uppercase tracking-wider text-ink-85 ring-1 ring-inset ring-ink-25 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue disabled:opacity-40 ${hoverTone}`}
		>
			{isActive && <Loader2 className="h-3 w-3 animate-spin" />}
			{isActive ? loadingLabel : label}
		</button>
	);
}

import { createFileRoute } from "@tanstack/react-router"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { AuthGate } from "@/components/auth-gate"

export const Route = createFileRoute("/bot")({
	component: BotPage,
})

type BotStatus = {
	service: string
	activeState: string
	subState: string
	mainPid?: number | null
	execMainStatus?: number | null
	startedAt?: string | null
}

type EnvPayload = {
	env: Record<string, string>
	path?: string
	allowlist?: string[]
}

function getAuthToken(): string | null {
	if (typeof window === "undefined") return null
	return localStorage.getItem("polywhaler_auth_token")
}

function useAuthHeaders(): Record<string, string> | null {
	const token = getAuthToken()
	if (!token) return null
	return { Authorization: `Bearer ${token}` }
}

function BotPage() {
	const [status, setStatus] = useState<BotStatus | null>(null)
	const [statusError, setStatusError] = useState<string | null>(null)
	const [statusLoading, setStatusLoading] = useState(false)
	const [actionLoading, setActionLoading] = useState<string | null>(null)
	const [logs, setLogs] = useState<string[]>([])
	const [logsError, setLogsError] = useState<string | null>(null)
	const [logsLoading, setLogsLoading] = useState(false)
	const [isStreaming, setIsStreaming] = useState(false)
	const [streamError, setStreamError] = useState<string | null>(null)
	const [envPayload, setEnvPayload] = useState<EnvPayload | null>(null)
	const [envEdits, setEnvEdits] = useState<Record<string, string>>({})
	const [envLoading, setEnvLoading] = useState(false)
	const [envSaving, setEnvSaving] = useState(false)
	const streamAbortRef = useRef<AbortController | null>(null)

	const authHeaders = useAuthHeaders()

	const canAuthed = useMemo(() => Boolean(authHeaders), [authHeaders])

	const loadStatus = useCallback(async () => {
		if (!authHeaders) return
		setStatusLoading(true)
		setStatusError(null)
		try {
			const response = await fetch("/api/bot-control/status", {
				headers: authHeaders ?? undefined,
			})
			if (!response.ok) {
				throw new Error(`Status failed (${response.status})`)
			}
			const payload = (await response.json()) as BotStatus
			setStatus(payload)
		} catch (error) {
			setStatusError(error instanceof Error ? error.message : "Failed to load status")
		} finally {
			setStatusLoading(false)
		}
	}, [authHeaders])

	const runAction = useCallback(
		async (action: "start" | "stop" | "restart") => {
			setActionLoading(action)
			setStatusError(null)
			try {
				const response = await fetch(`/api/bot-control/${action}`, {
					method: "POST",
					headers: authHeaders ?? undefined,
				})
				if (!response.ok) {
					throw new Error(`Action failed (${response.status})`)
				}
				const payload = (await response.json()) as BotStatus
				setStatus(payload)
			} catch (error) {
				setStatusError(error instanceof Error ? error.message : "Action failed")
			} finally {
				setActionLoading(null)
			}
		},
		[authHeaders],
	)

	const loadLogs = useCallback(async () => {
		if (!authHeaders) return
		setLogsLoading(true)
		setLogsError(null)
		try {
			const response = await fetch("/api/bot-control/logs?lines=200", {
				headers: authHeaders ?? undefined,
			})
			if (!response.ok) {
				throw new Error(`Logs failed (${response.status})`)
			}
			const payload = (await response.json()) as { lines: string[] }
			setLogs(payload.lines ?? [])
		} catch (error) {
			setLogsError(error instanceof Error ? error.message : "Failed to load logs")
		} finally {
			setLogsLoading(false)
		}
	}, [authHeaders])

	const stopStream = useCallback(() => {
		if (streamAbortRef.current) {
			streamAbortRef.current.abort()
			streamAbortRef.current = null
		}
		setIsStreaming(false)
	}, [])

	const startStream = useCallback(async () => {
		if (!authHeaders) {
			setStreamError("Missing auth token. Please log in again.")
			return
		}
		stopStream()
		setStreamError(null)
		setIsStreaming(true)

		const controller = new AbortController()
		streamAbortRef.current = controller

		try {
			const response = await fetch("/api/bot-control/logs/stream?lines=200", {
				headers: authHeaders,
				signal: controller.signal,
			})
			if (!response.ok || !response.body) {
				throw new Error(`Stream failed (${response.status})`)
			}
			const reader = response.body.getReader()
			const decoder = new TextDecoder()
			let buffer = ""

			while (true) {
				const { value, done } = await reader.read()
				if (done) break
				buffer += decoder.decode(value, { stream: true })
				const lines = buffer.split("\n")
				buffer = lines.pop() ?? ""
				const newLines: string[] = []
				for (const line of lines) {
					const trimmed = line.trimEnd()
					if (!trimmed) continue
					if (trimmed.startsWith("data:")) {
						const content = trimmed.slice(5).trimStart()
						if (content) newLines.push(content)
					} else if (!trimmed.startsWith("event:")) {
						newLines.push(trimmed)
					}
				}
				if (newLines.length) {
					setLogs((prev) => {
						const next = [...prev, ...newLines]
						if (next.length > 2000) {
							return next.slice(next.length - 2000)
						}
						return next
					})
				}
			}
		} catch (error) {
			if (!controller.signal.aborted) {
				setStreamError(error instanceof Error ? error.message : "Stream failed")
			}
		} finally {
			setIsStreaming(false)
		}
	}, [authHeaders, stopStream])

	const loadEnv = useCallback(async () => {
		if (!authHeaders) return
		setEnvLoading(true)
		try {
			const response = await fetch("/api/bot-control/env", {
				headers: authHeaders ?? undefined,
			})
			if (!response.ok) {
				throw new Error(`Env failed (${response.status})`)
			}
			const payload = (await response.json()) as EnvPayload
			setEnvPayload(payload)
			setEnvEdits(payload.env ?? {})
		} catch (error) {
			console.error("Failed to load env", error)
		} finally {
			setEnvLoading(false)
		}
	}, [authHeaders])

	const saveEnv = useCallback(async () => {
		if (!envPayload) return
		setEnvSaving(true)
		try {
			const updates: Record<string, string> = {}
			for (const [key, value] of Object.entries(envEdits)) {
				if (envPayload.env[key] !== value) {
					updates[key] = value
				}
			}
			if (!Object.keys(updates).length) {
				setEnvSaving(false)
				return
			}
			const response = await fetch("/api/bot-control/env", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(authHeaders ?? {}),
				},
				body: JSON.stringify({ updates }),
			})
			if (!response.ok) {
				throw new Error(`Env save failed (${response.status})`)
			}
			const payload = (await response.json()) as EnvPayload
			setEnvPayload(payload)
			setEnvEdits(payload.env ?? {})
		} catch (error) {
			console.error("Failed to save env", error)
		} finally {
			setEnvSaving(false)
		}
	}, [authHeaders, envEdits, envPayload])

	useEffect(() => {
		void loadStatus()
		void loadLogs()
		void loadEnv()
		return () => {
			stopStream()
		}
	}, [loadStatus, loadLogs, loadEnv, stopStream])

	return (
		<AuthGate>
			<div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-white p-6">
				<div className="max-w-5xl mx-auto space-y-6">
					<div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
						<div>
							<h1 className="text-3xl font-bold">Bot Control</h1>
							<p className="text-slate-400">Manage the VPS bot service and inspect logs.</p>
						</div>
						<div className="flex flex-wrap gap-2">
							<button
								type="button"
								onClick={() => void loadStatus()}
								className="rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold hover:border-cyan-400"
								disabled={statusLoading}
							>
								{statusLoading ? "Refreshing..." : "Refresh Status"}
							</button>
							<button
								type="button"
								onClick={() => void loadLogs()}
								className="rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold hover:border-cyan-400"
								disabled={logsLoading}
							>
								{logsLoading ? "Loading..." : "Reload Logs"}
							</button>
						</div>
					</div>

					{!canAuthed && (
						<div className="rounded-xl border border-amber-700/60 bg-amber-900/20 px-4 py-3 text-amber-200 text-sm">
							Authentication token missing. Log out and back in to enable bot controls.
						</div>
					)}

					<div className="grid gap-4 md:grid-cols-3">
						<div className="md:col-span-2 rounded-2xl border border-slate-800 bg-slate-950/60 p-5 space-y-4">
							<div className="flex items-center justify-between">
								<h2 className="text-lg font-semibold">Service Status</h2>
								<span className="text-xs text-slate-400">{status?.service ?? "polywhaler-bot"}</span>
							</div>
							{statusError && (
								<div className="rounded-lg border border-rose-800/60 bg-rose-950/40 px-3 py-2 text-rose-200 text-sm">
									{statusError}
								</div>
							)}
							<div className="grid gap-3 md:grid-cols-2 text-sm">
								<div>
									<div className="text-slate-400">Active</div>
									<div className="text-lg font-semibold">{status?.activeState ?? "--"}</div>
								</div>
								<div>
									<div className="text-slate-400">Substate</div>
									<div className="text-lg font-semibold">{status?.subState ?? "--"}</div>
								</div>
								<div>
									<div className="text-slate-400">Main PID</div>
									<div className="text-lg font-semibold">{status?.mainPid ?? "--"}</div>
								</div>
								<div>
									<div className="text-slate-400">Exit Code</div>
									<div className="text-lg font-semibold">{status?.execMainStatus ?? "--"}</div>
								</div>
								<div className="md:col-span-2">
									<div className="text-slate-400">Started</div>
									<div className="text-sm">{status?.startedAt ?? "--"}</div>
								</div>
							</div>
							<div className="flex flex-wrap gap-2">
								<button
									type="button"
									onClick={() => void runAction("start")}
									className="rounded-lg bg-emerald-500/90 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
									disabled={actionLoading !== null}
								>
									{actionLoading === "start" ? "Starting..." : "Start"}
								</button>
								<button
									type="button"
									onClick={() => void runAction("stop")}
									className="rounded-lg bg-rose-500/90 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-rose-400 disabled:opacity-50"
									disabled={actionLoading !== null}
								>
									{actionLoading === "stop" ? "Stopping..." : "Stop"}
								</button>
								<button
									type="button"
									onClick={() => void runAction("restart")}
									className="rounded-lg bg-cyan-500/90 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
									disabled={actionLoading !== null}
								>
									{actionLoading === "restart" ? "Restarting..." : "Restart"}
								</button>
							</div>
						</div>

						<div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5 space-y-3">
							<h2 className="text-lg font-semibold">Config</h2>
							{envLoading && <div className="text-sm text-slate-400">Loading env...</div>}
							{!envLoading && envPayload && (
								<div className="space-y-3">
									{envPayload.path && (
										<div className="text-xs text-slate-500 break-all">File: {envPayload.path}</div>
									)}
										<div className="space-y-2 max-h-64 overflow-auto pr-1">
											{Object.entries(envEdits).map(([key, value]) => (
												<div key={key} className="space-y-1">
													<label htmlFor={`env-${key}`} className="text-xs text-slate-400">
														{key}
													</label>
													<input
														id={`env-${key}`}
														value={value}
														onChange={(event) =>
															setEnvEdits((prev) => ({ ...prev, [key]: event.target.value }))
														}
													className="w-full rounded-md border border-slate-700 bg-slate-900/60 px-2 py-1 text-sm text-white focus:border-cyan-400 focus:outline-none"
												/>
											</div>
										))}
									</div>
									<button
										type="button"
										onClick={() => void saveEnv()}
										disabled={envSaving}
										className="w-full rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold hover:border-cyan-400 disabled:opacity-50"
									>
										{envSaving ? "Saving..." : "Save Env"}
									</button>
								</div>
							)}
							{!envLoading && !envPayload && (
								<div className="text-sm text-slate-500">Env editing is not configured.</div>
							)}
						</div>
					</div>

					<div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5 space-y-4">
						<div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
							<h2 className="text-lg font-semibold">Logs</h2>
							<div className="flex gap-2">
								<button
									type="button"
									onClick={() => void startStream()}
									disabled={isStreaming}
									className="rounded-lg bg-cyan-500/90 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
								>
									{isStreaming ? "Streaming..." : "Start Stream"}
								</button>
								<button
									type="button"
									onClick={stopStream}
									disabled={!isStreaming}
									className="rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold hover:border-cyan-400 disabled:opacity-50"
								>
									Stop Stream
								</button>
							</div>
						</div>
						{logsError && (
							<div className="rounded-lg border border-rose-800/60 bg-rose-950/40 px-3 py-2 text-rose-200 text-sm">
								{logsError}
							</div>
						)}
						{streamError && (
							<div className="rounded-lg border border-amber-800/60 bg-amber-950/40 px-3 py-2 text-amber-200 text-sm">
								{streamError}
							</div>
						)}
						<div className="rounded-xl border border-slate-800 bg-black/40 p-3 max-h-96 overflow-auto font-mono text-xs text-slate-200 whitespace-pre-wrap">
							{logs.length ? logs.join("\n") : "No logs yet."}
						</div>
					</div>
				</div>
			</div>
		</AuthGate>
	)
}

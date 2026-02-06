const textEncoder = new TextEncoder()

function toBase64Url(input: ArrayBuffer | Uint8Array | string): string {
	let bytes: Uint8Array
	if (typeof input === "string") {
		bytes = textEncoder.encode(input)
	} else if (input instanceof ArrayBuffer) {
		bytes = new Uint8Array(input)
	} else {
		bytes = input
	}

	let binary = ""
	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}

	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64Url(input: string): string {
	const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(
		Math.ceil(input.length / 4) * 4,
		"=",
	)
	const binary = atob(padded)
	let output = ""
	for (let i = 0; i < binary.length; i += 1) {
		output += binary[i]
	}
	return output
}

async function importKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		textEncoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	)
}

export async function signAuthToken(secret: string, expiresAtMs: number): Promise<string> {
	const payload = JSON.stringify({ exp: expiresAtMs })
	const key = await importKey(secret)
	const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload))
	return `${toBase64Url(payload)}.${toBase64Url(signature)}`
}

export async function verifyAuthToken(token: string, secret: string): Promise<boolean> {
	const [payloadEncoded, signatureEncoded] = token.split(".")
	if (!payloadEncoded || !signatureEncoded) return false

	const payload = fromBase64Url(payloadEncoded)
	let parsed: { exp?: number } | null = null
	try {
		parsed = JSON.parse(payload) as { exp?: number }
	} catch {
		return false
	}

	if (!parsed?.exp || parsed.exp <= Date.now()) return false

	const key = await importKey(secret)
	const expected = await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload))
	const expectedEncoded = toBase64Url(expected)
	return expectedEncoded === signatureEncoded
}

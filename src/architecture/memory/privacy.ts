/** Plain authored notes only: never accept pasted source/media as memory. */
export function noteText(value: string): string {
	if (
		/```|data:\w+\/|-----BEGIN [\w ]*PRIVATE KEY-----|^\s*(?:import \w|from \w[\w.]* import |def \w+\(|void main\s*\(|#version\s+\d)/m.test(
			value,
		)
	) {
		throw new Error(
			"Memory accepts plain notes, not source code, media, or private keys.",
		);
	}
	return redact(value);
}

/** Defense in depth for known secret formats, not a claim to detect all secrets. */
export function redact(value: string): string {
	return (
		value
			.replace(
				/\b(?:access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|api[_ -]?key|password|authorization|secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi,
				"[REDACTED]",
			)
			.replace(/\bBearer\s+[^\s;,]+/gi, "[REDACTED]")
			.replace(
				/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{15,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g,
				"[REDACTED]",
			)
			.replace(/[A-Za-z0-9_+-]{40,}={0,2}/g, "[REDACTED]")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: remove unsafe controls from persisted notes
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
	);
}

import Axios, { type AxiosError, type AxiosRequestConfig } from "axios";

export const AXIOS_INSTANCE = Axios.create({ timeout: 30000 });

function integerEnvironment(
	name: string,
	fallback: number,
	min: number,
	max: number,
): number {
	const raw = process.env[name] ?? String(fallback);
	const value = Number(raw);
	if (
		!/^\d+$/.test(raw) ||
		!Number.isSafeInteger(value) ||
		value < min ||
		value > max
	) {
		throw new Error(`${name} must be an integer between ${min} and ${max}.`);
	}
	return value;
}

/** Resolve after CLI parsing; importing this module must not freeze the target. */
function runtimeConnection(): { baseURL: string; timeout: number } {
	const host = process.env.TD_WEB_SERVER_HOST ?? "http://127.0.0.1";
	const invalidHost = () =>
		new Error(
			"TD_WEB_SERVER_HOST must be an HTTP(S) origin without credentials, query, fragment, or a non-root path.",
		);
	if (!/^https?:\/\/[^@/?#\\\s]+\/?$/i.test(host)) throw invalidHost();
	let url: URL;
	try {
		url = new URL(host);
	} catch {
		throw invalidHost();
	}
	if (
		url.username ||
		url.password ||
		!url.hostname ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	) {
		throw invalidHost();
	}
	// The separate port option is authoritative, including when the host has one.
	url.port = String(integerEnvironment("TD_WEB_SERVER_PORT", 9981, 1, 65535));
	return {
		baseURL: url.origin,
		timeout: integerEnvironment(
			"TD_WEB_SERVER_TIMEOUT_MS",
			30000,
			1000,
			120000,
		),
	};
}

export const customInstance = <T>(
	config: AxiosRequestConfig,
	options?: AxiosRequestConfig,
): Promise<T> => {
	const connection = runtimeConnection();
	const source = Axios.CancelToken.source();
	const promise = AXIOS_INSTANCE({
		...config,
		...options,
		...connection,
		cancelToken: source.token,
	}).then(({ data }) => data);

	// A timeout/cancel stops waiting for HTTP; it does not cancel Python already
	// running inside TouchDesigner. Never retry mutations automatically.
	// @ts-expect-error
	promise.cancel = () => {
		source.cancel("Query was cancelled");
	};

	return promise;
};

export type ErrorType<E> = AxiosError<E>;

export type BodyType<BodyData> = BodyData;

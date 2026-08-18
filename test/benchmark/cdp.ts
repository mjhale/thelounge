import {ChildProcess, spawn} from "node:child_process";
import {existsSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";

type CdpResponse = {
	id?: number;
	method?: string;
	params?: unknown;
	result?: any;
	error?: {message: string};
};

type PendingCommand = {
	resolve: (value: any) => void;
	reject: (error: Error) => void;
};

export class CdpClient {
	private readonly socket: WebSocket;
	private readonly pending = new Map<number, PendingCommand>();
	private readonly handlers = new Map<string, Array<(params: any) => void>>();
	private nextId = 1;

	private constructor(socket: WebSocket) {
		this.socket = socket;
		this.socket.addEventListener("message", (event) => this.onMessage(String(event.data)));
	}

	static async connect(url: string): Promise<CdpClient> {
		const socket = new WebSocket(url);

		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), {once: true});
			socket.addEventListener(
				"error",
				() => reject(new Error(`Could not connect to Chrome DevTools at ${url}`)),
				{once: true}
			);
		});

		return new CdpClient(socket);
	}

	async send<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
		const id = this.nextId++;
		const promise = new Promise<T>((resolve, reject) => {
			this.pending.set(id, {resolve, reject});
		});

		this.socket.send(JSON.stringify({id, method, params}));
		return promise;
	}

	on(method: string, handler: (params: any) => void): void {
		const handlers = this.handlers.get(method) ?? [];
		handlers.push(handler);
		this.handlers.set(method, handlers);
	}

	close(): void {
		this.socket.close();
	}

	private onMessage(rawMessage: string): void {
		const message = JSON.parse(rawMessage) as CdpResponse;

		if (message.id !== undefined) {
			const pending = this.pending.get(message.id);

			if (!pending) {
				return;
			}

			this.pending.delete(message.id);

			if (message.error) {
				pending.reject(new Error(`${message.error.message} (${rawMessage})`));
			} else {
				pending.resolve(message.result);
			}

			return;
		}

		if (message.method) {
			for (const handler of this.handlers.get(message.method) ?? []) {
				handler(message.params);
			}
		}
	}
}

export type ChromeSession = {
	cdp: CdpClient;
	process: ChildProcess;
	profileDirectory: string;
	requests: string[];
	consoleErrors: string[];
};

export async function launchChrome(
	chromePath: string,
	pageUrl: string,
	cpuRate: number
): Promise<ChromeSession> {
	const profileDirectory = mkdtempSync(path.join(tmpdir(), "thelounge-client-benchmark-"));
	const chromeProcess = spawn(
		chromePath,
		[
			"--headless=new",
			"--remote-debugging-port=0",
			`--user-data-dir=${profileDirectory}`,
			"--window-size=1440,900",
			"--force-device-scale-factor=1",
			"--disable-background-timer-throttling",
			"--disable-renderer-backgrounding",
			"--disable-backgrounding-occluded-windows",
			"--disable-extensions",
			"--disable-component-update",
			"--disable-background-networking",
			"--disable-default-apps",
			"--disable-sync",
			"--metrics-recording-only",
			"--no-first-run",
			"--no-default-browser-check",
			"about:blank",
		],
		{stdio: ["ignore", "ignore", "pipe"]}
	);
	let chromeStderr = "";
	chromeProcess.stderr?.on("data", (chunk) => {
		chromeStderr += String(chunk);
	});

	const devtoolsFile = path.join(profileDirectory, "DevToolsActivePort");
	await waitUntil(() => existsSync(devtoolsFile), 10000, "Chrome DevTools port file");
	const [port] = readFileSync(devtoolsFile, "utf8").trim().split("\n");
	let target: {webSocketDebuggerUrl: string} | undefined;

	for (let attempt = 0; attempt < 100 && !target; attempt++) {
		try {
			const targetResponse = await fetch(`http://127.0.0.1:${port}/json/list`);
			const targets = (await targetResponse.json()) as Array<{
				type: string;
				webSocketDebuggerUrl: string;
			}>;
			target = targets.find((candidate) => candidate.type === "page");
		} catch {
			// DevTools can expose its port shortly before the JSON endpoint is ready.
		}

		if (!target) {
			await delay(100);
		}
	}

	if (!target) {
		chromeProcess.kill("SIGTERM");
		rmSync(profileDirectory, {recursive: true, force: true});
		throw new Error(`Could not discover Chrome page target: ${chromeStderr}`);
	}

	const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
	const requests: string[] = [];
	const consoleErrors: string[] = [];

	cdp.on("Network.requestWillBeSent", (params) => requests.push(params.request.url));
	cdp.on("Runtime.consoleAPICalled", (params) => {
		if (params.type === "error" || params.type === "warning") {
			const argumentsList = params.args as Array<{
				value?: unknown;
				description?: string;
			}>;
			consoleErrors.push(
				argumentsList
					.map((argument) => String(argument.value ?? argument.description ?? ""))
					.join(" ")
			);
		}
	});
	cdp.on("Runtime.exceptionThrown", (params) => {
		consoleErrors.push(params.exceptionDetails?.exception?.description ?? "Runtime exception");
	});

	await Promise.all([
		cdp.send("Page.enable"),
		cdp.send("Runtime.enable"),
		cdp.send("Network.enable"),
		cdp.send("Performance.enable"),
		cdp.send("HeapProfiler.enable"),
	]);
	await cdp.send("Emulation.setDeviceMetricsOverride", {
		width: 1440,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await cdp.send("Emulation.setTimezoneOverride", {timezoneId: "UTC"});

	if (cpuRate !== 1) {
		await cdp.send("Emulation.setCPUThrottlingRate", {rate: cpuRate});
	}

	// Declared below so the injected browser source stays out of the CDP plumbing above.
	// eslint-disable-next-line no-use-before-define
	await cdp.send("Page.addScriptToEvaluateOnNewDocument", {source: benchmarkInstrumentation});
	await cdp.send("Page.navigate", {url: pageUrl});

	return {cdp, process: chromeProcess, profileDirectory, requests, consoleErrors};
}

export async function closeChrome(session: ChromeSession): Promise<void> {
	session.cdp.close();
	session.process.kill("SIGTERM");

	await Promise.race([
		new Promise<void>((resolve) => session.process.once("exit", () => resolve())),
		delay(3000),
	]);

	if (session.process.exitCode === null) {
		session.process.kill("SIGKILL");
	}

	const safePrefix = path.join(tmpdir(), "thelounge-client-benchmark-");

	if (!session.profileDirectory.startsWith(safePrefix)) {
		throw new Error(`Refusing to remove unexpected Chrome profile ${session.profileDirectory}`);
	}

	rmSync(session.profileDirectory, {recursive: true, force: true});
}

export async function evaluate<T>(
	cdp: CdpClient,
	expression: string,
	awaitPromise = true
): Promise<T> {
	const response = await withTimeout(
		cdp.send("Runtime.evaluate", {
			expression,
			awaitPromise,
			returnByValue: true,
		}),
		60000,
		`Chrome main thread did not answer within 60 seconds: ${expression}`
	);

	if (response.exceptionDetails) {
		throw new Error(response.exceptionDetails.exception?.description ?? expression);
	}

	return response.result.value as T;
}

export async function callFunction<T>(
	cdp: CdpClient,
	functionDeclaration: string,
	values: readonly unknown[] = []
): Promise<T> {
	const globalResponse = await withTimeout(
		cdp.send("Runtime.evaluate", {
			expression: "globalThis",
			returnByValue: false,
		}),
		60000,
		"Chrome main thread did not expose the global object within 60 seconds"
	);

	if (globalResponse.exceptionDetails) {
		throw new Error(globalResponse.exceptionDetails.exception?.description ?? "globalThis");
	}

	const objectId = globalResponse.result.objectId;

	try {
		const response = await withTimeout(
			cdp.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration,
				arguments: values.map((value) => ({value})),
				awaitPromise: true,
				returnByValue: true,
			}),
			60000,
			"Chrome main thread did not finish the parameterized function within 60 seconds"
		);

		if (response.exceptionDetails) {
			throw new Error(
				response.exceptionDetails.exception?.description ?? functionDeclaration
			);
		}

		return response.result.value as T;
	} finally {
		await cdp.send("Runtime.releaseObject", {objectId});
	}
}

export async function waitForExpression(
	cdp: CdpClient,
	expression: string,
	timeoutMs = 60000
): Promise<void> {
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeoutMs) {
		if (await evaluate<boolean>(cdp, `Boolean(${expression})`)) {
			return;
		}

		await delay(25);
	}

	throw new Error(`Timed out waiting for browser expression: ${expression}`);
}

export async function waitForFunction(
	cdp: CdpClient,
	functionDeclaration: string,
	values: readonly unknown[] = [],
	timeoutMs = 60000
): Promise<void> {
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeoutMs) {
		if (await callFunction<boolean>(cdp, functionDeclaration, values)) {
			return;
		}

		await delay(25);
	}

	throw new Error(`Timed out waiting for parameterized browser function: ${functionDeclaration}`);
}

export async function collectHeap(cdp: CdpClient): Promise<number> {
	await withTimeout(
		cdp.send("HeapProfiler.collectGarbage"),
		60000,
		"Chrome did not finish forced garbage collection within 60 seconds"
	);
	const usage = await withTimeout(
		cdp.send<{usedSize: number}>("Runtime.getHeapUsage"),
		60000,
		"Chrome did not report heap usage within 60 seconds"
	);
	return usage.usedSize;
}

export function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout<T>(
	promise: Promise<T>,
	milliseconds: number,
	message: string
): Promise<T> {
	let timeout: ReturnType<typeof setTimeout>;
	const rejection = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => reject(new Error(message)), milliseconds);
	});

	try {
		return await Promise.race([promise, rejection]);
	} finally {
		clearTimeout(timeout!);
	}
}

async function waitUntil(
	predicate: () => boolean,
	timeoutMs: number,
	description: string
): Promise<void> {
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeoutMs) {
		if (predicate()) {
			return;
		}

		await delay(25);
	}

	throw new Error(`Timed out waiting for ${description}`);
}

const benchmarkInstrumentation = String.raw`
(() => {
	const trackedListeners = new WeakMap();
	const nativeAddEventListener = EventTarget.prototype.addEventListener;
	const nativeRemoveEventListener = EventTarget.prototype.removeEventListener;
	const captureEnabled = (options) =>
		typeof options === "boolean" ? options : Boolean(options?.capture);
	const trackedSet = (target, type, capture) => {
		let targetListeners = trackedListeners.get(target);
		if (!targetListeners) {
			targetListeners = new Map();
			trackedListeners.set(target, targetListeners);
		}

		const key = type + ":" + Number(capture);
		let listeners = targetListeners.get(key);
		if (!listeners) {
			listeners = new Set();
			targetListeners.set(key, listeners);
		}
		return listeners;
	};
	EventTarget.prototype.addEventListener = function(type, listener, options) {
		const result = nativeAddEventListener.call(this, type, listener, options);
		if (listener) {
			trackedSet(this, type, captureEnabled(options)).add(listener);
		}
		return result;
	};
	EventTarget.prototype.removeEventListener = function(type, listener, options) {
		const result = nativeRemoveEventListener.call(this, type, listener, options);
		if (listener) {
			trackedSet(this, type, captureEnabled(options)).delete(listener);
		}
		return result;
	};
	const listenerCount = (target, predicate) => {
		const targetListeners = trackedListeners.get(target);
		if (!targetListeners) {
			return 0;
		}

		let total = 0;
		for (const [key, listeners] of targetListeners) {
			const type = key.slice(0, key.lastIndexOf(":"));
			if (predicate(type)) {
				total += listeners.size;
			}
		}
		return total;
	};

	// History pages are requested explicitly by the harness. This prevents the
	// load-more observer and a scripted click from racing for the same cursor.
	Object.defineProperty(window, "IntersectionObserver", {
		value: undefined,
		configurable: true,
	});
	localStorage.setItem("user", "benchmark-user");
	localStorage.setItem("token", "benchmark-token");
	localStorage.setItem("thelounge.state.sidebar", "false");
	localStorage.setItem("thelounge.state.userlist", "false");
	localStorage.setItem("settings", JSON.stringify({autocomplete: false}));

	const state = {
		navigationStart: performance.now(),
		longTasks: [],
		inputSamples: [],
		probeTimer: null,
		probeExpected: 0,
		recordLongTasks: true,
	};
	const probeInterval = 100;

	new PerformanceObserver((list) => {
		if (!state.recordLongTasks) {
			return;
		}

		for (const entry of list.getEntries()) {
			state.longTasks.push({startTime: entry.startTime, duration: entry.duration});
		}
	}).observe({type: "longtask", buffered: true});

	const twoFrames = () => new Promise((resolve) => {
		requestAnimationFrame(() => requestAnimationFrame(resolve));
	});

	const summarize = (values) => {
		if (values.length === 0) {
			return {count: 0, p50: 0, p95: 0, max: 0, sum: 0};
		}

		const sorted = [...values].sort((a, b) => a - b);
		const percentile = (value) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))];

		return {
			count: sorted.length,
			p50: percentile(0.5),
			p95: percentile(0.95),
			max: sorted[sorted.length - 1],
			sum: sorted.reduce((total, value) => total + value, 0),
		};
	};

	window.__tlBenchmark = {
		state,
		listenerSnapshot() {
			return {
				windowResize: listenerCount(window, (type) => type === "resize"),
				documentTouch: listenerCount(document, (type) => type.startsWith("touch")),
				messageTouch: [...document.querySelectorAll("#chat .messages .msg")]
					.reduce((total, element) =>
						total + listenerCount(element, (type) => type.startsWith("touch")), 0),
			};
		},
		reset() {
			state.longTasks = [];
			state.inputSamples = [];
			state.recordLongTasks = true;
			return performance.now();
		},
		startInputProbe() {
			state.inputSamples = [];
			state.probeExpected = performance.now() + probeInterval;

			const tick = () => {
				const now = performance.now();
				const input = document.querySelector("#input");

				if (input) {
					const started = performance.now();
					input.value = input.value === "x" ? "xx" : "x";
					input.dispatchEvent(new InputEvent("input", {
						bubbles: true,
						data: "x",
						inputType: "insertText",
					}));
					const handled = performance.now();

					requestAnimationFrame(() => {
						state.inputSamples.push({
							timerDelay: Math.max(0, now - state.probeExpected),
							handler: handled - started,
							paint: performance.now() - started,
						});
					});
				}

				state.probeExpected += probeInterval;
				state.probeTimer = setTimeout(tick, Math.max(0, state.probeExpected - performance.now()));
			};

			state.probeTimer = setTimeout(tick, probeInterval);
		},
		async stopInputProbe() {
			clearTimeout(state.probeTimer);
			state.probeTimer = null;
			await twoFrames();
			return {
				timerDelay: summarize(state.inputSamples.map((sample) => sample.timerDelay)),
				handler: summarize(state.inputSamples.map((sample) => sample.handler)),
				paint: summarize(state.inputSamples.map((sample) => sample.paint)),
			};
		},
		async finish(startedAt) {
			await twoFrames();
			const relevantTasks = state.longTasks.filter((task) => task.startTime >= startedAt);
			const durations = relevantTasks.map((task) => task.duration);
			const result = {
				durationMs: performance.now() - startedAt,
				longTasks: summarize(durations),
				totalBlockingTimeMs: durations.reduce((total, duration) => total + Math.max(0, duration - 50), 0),
			};
			state.recordLongTasks = false;
			state.longTasks = [];
			return result;
		},
		async initial() {
			await twoFrames();
			const result = {
				durationMs: performance.now() - state.navigationStart,
				longTasks: summarize(state.longTasks.map((task) => task.duration)),
				totalBlockingTimeMs: state.longTasks.reduce(
					(total, task) => total + Math.max(0, task.duration - 50),
					0
				),
			};
			state.recordLongTasks = false;
			state.longTasks = [];
			return result;
		},
	};
})();
`;

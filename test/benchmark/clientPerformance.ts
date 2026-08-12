/* eslint-disable no-console */

import {execFileSync, spawnSync} from "node:child_process";
import {readFileSync, writeFileSync} from "node:fs";
import {createServer, Server as HttpServer} from "node:http";
import path from "node:path";
import express from "express";
import {Server as SocketServer, Socket} from "socket.io";

import {SharedMsg} from "../../shared/types/msg";
import {
	CdpClient,
	ChromeSession,
	closeChrome,
	collectHeap,
	delay,
	evaluate,
	launchChrome,
	waitForExpression,
} from "./cdp";
import {
	BenchmarkChannelFixture,
	expectedIds,
	makeMessage,
	makeMessages,
	makeNetwork,
} from "./clientPerformanceFixtures";

type ScenarioName = "control" | "large-history" | "long-session";

type Arguments = {
	runs: number;
	chromePath: string;
	cpuRate: number;
	outputPath?: string;
	skipBuild: boolean;
	scenario?: ScenarioName;
};

type SummaryStats = {
	count: number;
	p50: number;
	p95: number;
	max: number;
	sum: number;
};

type PhaseMetrics = {
	durationMs: number;
	longTasks: SummaryStats;
	totalBlockingTimeMs: number;
};

type InputMetrics = {
	timerDelay: SummaryStats;
	handler: SummaryStats;
	paint: SummaryStats;
};

type DomSnapshot = {
	messageIds: number[];
	messageCount: number;
	messageElementCount: number;
	descendantElementCount: number;
	totalElementCount: number;
	bottomOffset: number;
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
	unreadMarkerCount: number;
	dateMarkerCount: number;
	role: string | null;
	ariaLive: string | null;
};

type Reachability = {
	passed: boolean;
	reachableCount: number;
	expectedCount: number;
	missing: number[];
	unexpected: number[];
	localOrderValid: boolean;
	localDuplicates: number[];
	windowTransitions: number;
};

type IdComparison = {
	passed: boolean;
	actualCount: number;
	expectedCount: number;
	missing: number[];
	unexpected: number[];
	duplicates: number[];
	ordered: boolean;
};

type Correctness = Record<
	string,
	boolean | number | number[] | Reachability | IdComparison | undefined
> & {
	stabilityHeapDeltaBytes?: number;
};

type BrowserRun = {
	scenario: ScenarioName;
	run: number;
	phases: Record<string, PhaseMetrics>;
	input: Record<string, InputMetrics>;
	dom: Record<string, Omit<DomSnapshot, "messageIds">>;
	heapBytes: Record<string, number>;
	correctness: Correctness;
	consoleErrors: string[];
	externalRequests: string[];
};

type Scenario = {
	fixture: BenchmarkChannelFixture;
	secondaryMessage: SharedMsg;
	pageSize: number;
};

const livePhaseMessageCount = 1599;
const stabilityCycleMessageCount = 600;

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
};

const repositoryRoot = path.resolve(__dirname, "../..");
const publicDirectory = path.join(repositoryRoot, "public");

class BenchmarkHost {
	private readonly app = express();
	private readonly httpServer: HttpServer;
	private readonly sockets: SocketServer;
	private scenario?: Scenario;
	private activeSocket?: Socket;
	private ready = deferred<void>();
	private pageUrl = "";

	constructor() {
		this.httpServer = createServer(this.app);
		this.sockets = new SocketServer(this.httpServer, {
			serveClient: false,
			transports: ["websocket"],
			pingInterval: 300000,
			pingTimeout: 300000,
		});
		this.app.get("/", (_request, response) => {
			response.type("html").send(injectBenchmarkHtml());
		});
		this.app.use(express.static(publicDirectory));
		this.sockets.on("connection", (socket) => this.onConnection(socket));
	}

	async start(): Promise<string> {
		await new Promise<void>((resolve, reject) => {
			this.httpServer.once("error", reject);
			this.httpServer.listen(0, "127.0.0.1", () => resolve());
		});
		const address = this.httpServer.address();

		if (!address || typeof address === "string") {
			throw new Error("Benchmark server did not expose a TCP address");
		}

		this.pageUrl = `http://127.0.0.1:${address.port}/`;
		return this.pageUrl;
	}

	prepare(scenario: Scenario): void {
		this.scenario = scenario;
		this.activeSocket = undefined;
		this.ready = deferred<void>();
	}

	waitUntilReady(): Promise<void> {
		return this.ready.promise;
	}

	emitMessages(messages: SharedMsg[]): void {
		const scenario = this.requireScenario();
		const socket = this.requireSocket();

		for (const message of messages) {
			scenario.fixture.history.push(message);
			scenario.fixture.totalMessages++;
			socket.emit("msg", {chan: 2, msg: message, unread: 0, highlight: 0});
		}
	}

	emitReconnect(messages: SharedMsg[]): void {
		const scenario = this.requireScenario();
		const socket = this.requireSocket();

		scenario.fixture.history.push(...messages);
		scenario.fixture.totalMessages += messages.length;
		const network = makeNetwork(scenario.fixture, scenario.secondaryMessage, messages);
		network.channels[2].messages = [];
		socket.emit("init", {
			active: 2,
			networks: [network],
			token: "benchmark-token",
		});
	}

	emitHistoryPage(lastId: number): void {
		const scenario = this.requireScenario();
		scenario.fixture.totalMessages = scenario.fixture.history.length;
		this.sendMore(this.requireSocket(), 2, lastId);
	}

	async close(): Promise<void> {
		await new Promise<void>((resolve) => this.sockets.close(() => resolve()));

		if (this.httpServer.listening) {
			await new Promise<void>((resolve, reject) => {
				this.httpServer.close((error) => (error ? reject(error) : resolve()));
			});
		}
	}

	private onConnection(socket: Socket): void {
		if (!this.scenario) {
			socket.disconnect(true);
			return;
		}

		this.activeSocket = socket;
		socket.on("auth:perform", () => {
			const scenario = this.requireScenario();
			// Kept with the other fixture constants at the end of the benchmark.
			// eslint-disable-next-line no-use-before-define
			socket.emit("configuration", configuration);
			socket.emit("auth:success");
			socket.emit("init", {
				active: 2,
				networks: [makeNetwork(scenario.fixture, scenario.secondaryMessage)],
				token: "benchmark-token",
			});
			this.ready.resolve();
		});
		socket.on("setting:get", () => socket.emit("setting:all", {statusMessages: "condensed"}));
		socket.on("names", ({target}) => socket.emit("names", {id: target, users: []}));
		socket.on("more", ({target, lastId}) => this.sendMore(socket, target, lastId));
		socket.emit("auth:start", 424242);
	}

	private sendMore(socket: Socket, target: number, lastId: number): void {
		const scenario = this.requireScenario();

		if (target !== 2) {
			return;
		}

		const index = scenario.fixture.history.findIndex((message) => message.id === lastId);

		if (index < 0) {
			throw new Error(`Benchmark history cursor ${lastId} was not found`);
		}

		const messages = scenario.fixture.history.slice(
			Math.max(0, index - scenario.pageSize),
			index
		);
		console.error(
			`[history] cursor ${lastId}: ${messages.at(0)?.id ?? "empty"}-${
				messages.at(-1)?.id ?? "empty"
			}`
		);
		socket.emit("more", {
			chan: 2,
			messages,
			totalMessages: scenario.fixture.totalMessages,
		});
	}

	private requireScenario(): Scenario {
		if (!this.scenario) {
			throw new Error("Benchmark scenario is not prepared");
		}

		return this.scenario;
	}

	private requireSocket(): Socket {
		if (!this.activeSocket) {
			throw new Error("Benchmark browser socket is not connected");
		}

		return this.activeSocket;
	}
}

async function runControl(
	host: BenchmarkHost,
	pageUrl: string,
	args: Arguments,
	run: number
): Promise<BrowserRun> {
	const messages = makeMessages(1, 100);
	const scenario = makeScenario(messages, messages, 100);
	host.prepare(scenario);
	const session = await openScenario(host, pageUrl, args, 100);

	try {
		const initial = await initialMetrics(session.cdp);
		const dom = await getDomSnapshot(session.cdp);
		const heap = await collectHeap(session.cdp);
		const reachability = await collectReachableMessages(session.cdp, expectedIds(messages));

		return finishRun(session, {
			scenario: "control",
			run,
			phases: {initial},
			input: {},
			dom: {initial: withoutMessageIds(dom)},
			heapBytes: {initial: heap},
			correctness: {
				reachability,
				bottomAnchored: dom.bottomOffset <= 30,
				accessibility: dom.role === "log" && dom.ariaLive === "polite",
				unreadMarkers: dom.unreadMarkerCount <= 1,
			},
		});
	} finally {
		await closeChrome(session);
	}
}

async function runLargeHistory(
	host: BenchmarkHost,
	pageUrl: string,
	args: Arguments,
	run: number
): Promise<BrowserRun> {
	const history = makeMessages(1, 10000);
	const initialMessages = history.slice(-100);
	const scenario = makeScenario(history, initialMessages, 1000);
	host.prepare(scenario);
	const session = await openScenario(host, pageUrl, args, 10000);

	try {
		const initial = await initialMetrics(session.cdp);
		const heapAt100 = await collectHeap(session.cdp);
		await scrollToTop(session.cdp);
		const startedAt = await resetMetrics(session.cdp);
		await startInputProbe(session.cdp);
		const anchorErrors: number[] = [];
		let oldestId = 9901;

		while (oldestId > 1) {
			await scrollToTop(session.cdp);
			const anchor = await getFirstVisibleAnchor(session.cdp);
			await clickOlderMessages(session.cdp);
			oldestId = Math.max(1, oldestId - 1000);
			await waitForMessage(session.cdp, oldestId, 120000);
			await waitForHistoryIdle(session.cdp);

			if (anchor) {
				const current = await getMessageOffset(session.cdp, anchor.id);

				if (current !== null) {
					anchorErrors.push(Math.abs(current - anchor.offset));
				}
			}
		}

		const input = await stopInputProbe(session.cdp);
		const loadHistory = await finishPhase(session.cdp, startedAt);
		const dom = await getDomSnapshot(session.cdp);
		console.error(`[run ${run}] large-history: rendered ${dom.messageCount} messages`);
		const heapAt10000 = await collectHeap(session.cdp);
		const reachability = await collectReachableMessages(session.cdp, expectedIds(history), 120);

		return finishRun(session, {
			scenario: "large-history",
			run,
			phases: {initial, loadHistory},
			input: {loadHistory: input},
			dom: {at10000: withoutMessageIds(dom)},
			heapBytes: {at100: heapAt100, at10000: heapAt10000},
			correctness: {
				reachability,
				ordered: isStrictlyIncreasing(dom.messageIds),
				duplicateIds: duplicates(dom.messageIds).slice(0, 20),
				maxPrependAnchorErrorPx: Math.max(0, ...anchorErrors),
				accessibility: dom.role === "log" && dom.ariaLive === "polite",
				unreadMarkers: dom.unreadMarkerCount <= 1,
			},
		});
	} finally {
		await closeChrome(session);
	}
}

async function runLongSession(
	host: BenchmarkHost,
	pageUrl: string,
	args: Arguments,
	run: number
): Promise<BrowserRun> {
	const history = makeMessages(1, 11000);
	const initialMessages = history.slice(-100);
	const scenario = makeScenario(history, initialMessages, 1000);
	host.prepare(scenario);
	const session = await openScenario(host, pageUrl, args, 11000);

	try {
		const phases: Record<string, PhaseMetrics> = {initial: await initialMetrics(session.cdp)};
		const input: Record<string, InputMetrics> = {};
		const dom: Record<string, Omit<DomSnapshot, "messageIds">> = {};
		const heapBytes: Record<string, number> = {initial: await collectHeap(session.cdp)};
		const correctness: Correctness = {};
		let loadedHistoryFirstId = 0;

		let nextId = 11001;
		let startedAt = await resetMetrics(session.cdp);
		await startInputProbe(session.cdp);
		await emitInBursts(host, makeMessages(nextId, livePhaseMessageCount));
		nextId += livePhaseMessageCount;
		input.bottomBurst = await stopInputProbe(session.cdp);
		await waitForMessage(session.cdp, nextId - 1, 120000);
		phases.bottomBurst = await finishPhase(session.cdp, startedAt);
		const bottomDom = await getDomSnapshot(session.cdp);
		dom.afterBottomBurst = withoutMessageIds(bottomDom);
		heapBytes.afterBottomBurst = await collectHeap(session.cdp);
		correctness.bottomRetention = compareIds(
			bottomDom.messageIds,
			range(nextId - 1500, nextId)
		);
		loadedHistoryFirstId = nextId - 1500;
		correctness.bottomAnchored = bottomDom.bottomOffset <= 30;
		console.error(`[run ${run}] long-session: bottom burst complete`);

		correctness.scrollEventsNeeded = await scrollUp(session.cdp);
		startedAt = await resetMetrics(session.cdp);
		await startInputProbe(session.cdp);
		await emitInBursts(host, makeMessages(nextId, livePhaseMessageCount));
		nextId += livePhaseMessageCount;
		input.scrolledBurst = await stopInputProbe(session.cdp);
		await waitForMessage(session.cdp, nextId - 1, 120000);
		phases.scrolledBurst = await finishPhase(session.cdp, startedAt);
		const scrolledDom = await getDomSnapshot(session.cdp);
		dom.afterScrolledBurst = withoutMessageIds(scrolledDom);
		heapBytes.afterScrolledBurst = await collectHeap(session.cdp);
		correctness.scrolledOrder = isStrictlyIncreasing(scrolledDom.messageIds);
		correctness.scrolledNewestReachable = scrolledDom.messageIds.at(-1) === nextId - 1;
		console.error(`[run ${run}] long-session: scrolled burst complete`);

		startedAt = await resetMetrics(session.cdp);
		const anchorErrors: number[] = [];

		for (let page = 0; page < 2; page++) {
			await scrollToTop(session.cdp);
			const anchor = await getFirstVisibleAnchor(session.cdp);
			const beforePrepend = await getDomSnapshot(session.cdp);
			loadedHistoryFirstId = beforePrepend.messageIds[0];
			host.emitHistoryPage(loadedHistoryFirstId);
			loadedHistoryFirstId = Math.max(1, loadedHistoryFirstId - 1000);
			const expectedOldest = loadedHistoryFirstId;
			await waitForMessage(session.cdp, expectedOldest, 120000);
			await waitForHistoryIdle(session.cdp);

			if (anchor) {
				const current = await getMessageOffset(session.cdp, anchor.id);

				if (current !== null) {
					anchorErrors.push(Math.abs(current - anchor.offset));
				}
			}
		}

		phases.historyPrepends = await finishPhase(session.cdp, startedAt);
		const prependedDom = await getDomSnapshot(session.cdp);
		dom.afterPrepends = withoutMessageIds(prependedDom);
		heapBytes.afterPrepends = await collectHeap(session.cdp);
		correctness.maxPrependAnchorErrorPx = Math.max(0, ...anchorErrors);
		correctness.loadedHistory = await collectReachableMessages(
			session.cdp,
			range(loadedHistoryFirstId, nextId),
			80
		);
		console.error(`[run ${run}] long-session: history prepends complete`);

		startedAt = await resetMetrics(session.cdp);
		await switchChannel(session.cdp, 3, scenario.secondaryMessage.id);
		await switchChannel(session.cdp, 2, nextId - 1);
		phases.channelRoundTrip = await finishPhase(session.cdp, startedAt);
		const switchedDom = await getDomSnapshot(session.cdp);
		dom.afterSwitch = withoutMessageIds(switchedDom);
		heapBytes.afterSwitch = await collectHeap(session.cdp);
		correctness.switchTrim = compareIds(switchedDom.messageIds, range(nextId - 100, nextId));

		const reconnectMessages = makeMessages(nextId, 64);
		startedAt = await resetMetrics(session.cdp);
		host.emitReconnect(reconnectMessages);
		nextId += reconnectMessages.length;
		await waitForMessage(session.cdp, nextId - 1, 120000);
		phases.reconnectMerge = await finishPhase(session.cdp, startedAt);
		const reconnectDom = await getDomSnapshot(session.cdp);
		dom.afterReconnect = withoutMessageIds(reconnectDom);
		correctness.reconnectMerge = compareIds(
			reconnectDom.messageIds,
			range(nextId - reconnectMessages.length - 100, nextId)
		);
		console.error(`[run ${run}] long-session: switch and reconnect complete`);

		const stabilityHeaps: number[] = [];
		const stabilityDomCounts: number[] = [];

		for (let cycle = 0; cycle < 3; cycle++) {
			await jumpToBottom(session.cdp);
			await emitInBursts(host, makeMessages(nextId, stabilityCycleMessageCount), 5);
			nextId += stabilityCycleMessageCount;
			await waitForMessage(session.cdp, nextId - 1, 120000);
			await switchChannel(session.cdp, 3, scenario.secondaryMessage.id);
			await switchChannel(session.cdp, 2, nextId - 1);
			const cycleDom = await getDomSnapshot(session.cdp);
			stabilityDomCounts.push(cycleDom.messageCount);
			stabilityHeaps.push(await collectHeap(session.cdp));
			console.error(`[run ${run}] long-session: stability cycle ${cycle + 1} complete`);
		}

		heapBytes.stabilityCycle1 = stabilityHeaps[0];
		heapBytes.stabilityCycle2 = stabilityHeaps[1];
		heapBytes.stabilityCycle3 = stabilityHeaps[2];
		correctness.stabilityDomCounts = stabilityDomCounts;
		correctness.monotonicHeapGrowth =
			stabilityHeaps[0] < stabilityHeaps[1] && stabilityHeaps[1] < stabilityHeaps[2];
		correctness.stabilityHeapDeltaBytes = stabilityHeaps[2] - stabilityHeaps[0];

		return finishRun(session, {
			scenario: "long-session",
			run,
			phases,
			input,
			dom,
			heapBytes,
			correctness,
		});
	} finally {
		await closeChrome(session);
	}
}

async function openScenario(
	host: BenchmarkHost,
	pageUrl: string,
	args: Arguments,
	lastMessageId: number
): Promise<ChromeSession> {
	const session = await launchChrome(args.chromePath, pageUrl, args.cpuRate);

	await Promise.all([
		host.waitUntilReady(),
		waitForMessage(session.cdp, lastMessageId, 120000),
		waitForExpression(session.cdp, "document.querySelector('#input')", 120000),
	]);
	return session;
}

async function emitInBursts(
	host: BenchmarkHost,
	messages: SharedMsg[],
	pauseMs = 50
): Promise<void> {
	for (let index = 0; index < messages.length; index += 100) {
		host.emitMessages(messages.slice(index, index + 100));
		await delay(pauseMs);
	}
}

async function initialMetrics(cdp: CdpClient): Promise<PhaseMetrics> {
	return evaluate<PhaseMetrics>(cdp, "window.__tlBenchmark.initial()");
}

async function resetMetrics(cdp: CdpClient): Promise<number> {
	return evaluate<number>(cdp, "window.__tlBenchmark.reset()");
}

async function startInputProbe(cdp: CdpClient): Promise<void> {
	await evaluate(cdp, "window.__tlBenchmark.startInputProbe()", false);
}

async function stopInputProbe(cdp: CdpClient): Promise<InputMetrics> {
	return evaluate<InputMetrics>(cdp, "window.__tlBenchmark.stopInputProbe()");
}

async function finishPhase(cdp: CdpClient, startedAt: number): Promise<PhaseMetrics> {
	return evaluate<PhaseMetrics>(cdp, `window.__tlBenchmark.finish(${startedAt})`);
}

async function getDomSnapshot(cdp: CdpClient): Promise<DomSnapshot> {
	return evaluate<DomSnapshot>(
		cdp,
		`(() => {
			const chat = document.querySelector("#chat .chat");
			const messages = document.querySelector("#chat .messages");
			const ids = [...document.querySelectorAll('#chat .messages [id^="msg-"]')]
				.map((element) => Number(element.id.slice(4)))
				.filter(Number.isFinite);
			return {
				messageIds: ids,
				messageCount: ids.length,
				messageElementCount: document.querySelectorAll("#chat .messages .msg").length,
				descendantElementCount: messages?.querySelectorAll("*").length ?? 0,
				totalElementCount: document.querySelectorAll("*").length,
				bottomOffset: chat ? chat.scrollHeight - chat.scrollTop - chat.clientHeight : -1,
				scrollTop: chat?.scrollTop ?? -1,
				scrollHeight: chat?.scrollHeight ?? -1,
				clientHeight: chat?.clientHeight ?? -1,
				unreadMarkerCount: document.querySelectorAll("#chat .unread-marker").length,
				dateMarkerCount: document.querySelectorAll("#chat .date-marker").length,
				role: messages?.getAttribute("role") ?? null,
				ariaLive: messages?.getAttribute("aria-live") ?? null,
			};
		})()`
	);
}

async function scrollToTop(cdp: CdpClient): Promise<void> {
	await evaluate(
		cdp,
		`(() => {
			const chat = document.querySelector("#chat .chat");
			chat.scrollTop = 0;
			chat.dispatchEvent(new Event("scroll"));
			chat.dispatchEvent(new Event("scroll"));
		})()`
	);
	await waitForExpression(cdp, "document.querySelector('#chat .scroll-down-shown')", 10000);
}

async function scrollUp(cdp: CdpClient): Promise<number> {
	for (let events = 1; events <= 2; events++) {
		await evaluate(
			cdp,
			`(() => {
				const chat = document.querySelector("#chat .chat");
				chat.scrollTop = Math.max(0, chat.scrollHeight - chat.clientHeight - 600);
				chat.dispatchEvent(new Event("scroll"));
			})()`
		);
		await delay(50);

		if (
			await evaluate<boolean>(
				cdp,
				"Boolean(document.querySelector('#chat .scroll-down-shown'))"
			)
		) {
			return events;
		}
	}

	throw new Error("Could not move the active message list away from the bottom");
}

async function jumpToBottom(cdp: CdpClient): Promise<void> {
	await evaluate(
		cdp,
		`(() => {
			const button = document.querySelector("#chat .scroll-down");
			button.click();
		})()`
	);
	await waitForExpression(
		cdp,
		"(() => { const chat = document.querySelector('#chat .chat'); return chat && chat.scrollHeight - chat.scrollTop - chat.clientHeight <= 30; })()",
		30000
	);
}

async function clickOlderMessages(cdp: CdpClient): Promise<void> {
	await evaluate(
		cdp,
		`(() => {
			const button = document.querySelector(
				'[data-message-window="older"] button, .show-more:not(.show-newer) .btn'
			);
			if (!button) {
				throw new Error("Older messages button is unavailable");
			}
			button.click();
		})()`
	);
}

async function waitForHistoryIdle(cdp: CdpClient): Promise<void> {
	await waitForExpression(
		cdp,
		`(() => {
			const button = document.querySelector(
				'[data-message-window="older"] button, .show-more:not(.show-newer) .btn'
			);
			return !button || !button.disabled;
		})()`,
		30000
	);
}

async function getFirstVisibleAnchor(cdp: CdpClient): Promise<{id: number; offset: number} | null> {
	return evaluate(
		cdp,
		`(() => {
			const chat = document.querySelector("#chat .chat");
			const chatTop = chat.getBoundingClientRect().top;
			const message = [...document.querySelectorAll("#chat .messages > .msg")]
				.find((element) => element.getBoundingClientRect().bottom > chatTop);
			const identified = message?.matches('[id^="msg-"]')
				? message
				: message?.querySelector('[id^="msg-"]');
			return identified ? {
				id: Number(identified.id.slice(4)),
				offset: identified.getBoundingClientRect().top - chatTop,
			} : null;
		})()`
	);
}

async function getMessageOffset(cdp: CdpClient, id: number): Promise<number | null> {
	return evaluate(
		cdp,
		`(() => {
			const chat = document.querySelector("#chat .chat");
			const message = document.querySelector("#msg-${id}");
			return message ? message.getBoundingClientRect().top - chat.getBoundingClientRect().top : null;
		})()`
	);
}

async function switchChannel(
	cdp: CdpClient,
	channelId: number,
	expectedMessageId: number
): Promise<void> {
	await evaluate(
		cdp,
		`(() => {
			const channel = document.querySelector(
				'.channel-list-item[aria-controls="#chan-${channelId}"]'
			);
			if (!channel) {
				throw new Error("Channel ${channelId} is unavailable");
			}
			channel.click();
		})()`
	);
	await waitForExpression(
		cdp,
		`document.querySelector('#chan-${channelId} #msg-${expectedMessageId}')`,
		60000
	);
}

async function waitForMessage(cdp: CdpClient, id: number, timeoutMs: number): Promise<void> {
	await waitForExpression(cdp, `document.querySelector('#msg-${id}')`, timeoutMs);
}

async function collectReachableMessages(
	cdp: CdpClient,
	expected: number[],
	maxTransitions = 50
): Promise<Reachability> {
	let localOrderValid = true;
	const localDuplicates = new Set<number>();
	const reachable = new Set<number>();
	let windowTransitions = 0;

	const collect = async () => {
		const ids = (await getDomSnapshot(cdp)).messageIds;
		localOrderValid &&= isStrictlyIncreasing(ids);

		for (const id of duplicates(ids)) {
			localDuplicates.add(id);
		}

		for (const id of ids) {
			reachable.add(id);
		}

		return ids;
	};

	await collect();

	for (let transition = 0; transition < maxTransitions; transition++) {
		const changed = await clickWindowButton(cdp, "older");

		if (!changed) {
			break;
		}

		windowTransitions++;
		await collect();
	}

	await collect();

	for (let transition = 0; transition < maxTransitions; transition++) {
		const changed = await clickWindowButton(cdp, "newer");

		if (!changed) {
			break;
		}

		windowTransitions++;
		await collect();
	}

	const expectedSet = new Set(expected);
	const missing = expected.filter((id) => !reachable.has(id));
	const unexpected = [...reachable].filter((id) => !expectedSet.has(id));

	return {
		passed:
			missing.length === 0 &&
			unexpected.length === 0 &&
			localOrderValid &&
			localDuplicates.size === 0,
		reachableCount: reachable.size,
		expectedCount: expected.length,
		missing: missing.slice(0, 20),
		unexpected: unexpected.slice(0, 20),
		localOrderValid,
		localDuplicates: [...localDuplicates].slice(0, 20),
		windowTransitions,
	};
}

async function clickWindowButton(cdp: CdpClient, direction: "older" | "newer"): Promise<boolean> {
	const before = await evaluate<string | null>(
		cdp,
		`(() => {
			const button = document.querySelector('[data-message-window="${direction}"] button');
			if (!button || button.disabled || button.offsetParent === null) {
				return null;
			}
			const ids = [...document.querySelectorAll('#chat .messages [id^="msg-"]')];
			const signature = [ids[0]?.id, ids.at(-1)?.id, ids.length].join(":");
			button.click();
			return signature;
		})()`
	);

	if (before === null) {
		return false;
	}

	await waitForExpression(
		cdp,
		`(() => {
			const ids = [...document.querySelectorAll('#chat .messages [id^="msg-"]')];
			return [ids[0]?.id, ids.at(-1)?.id, ids.length].join(":") !== ${JSON.stringify(before)};
		})()`,
		30000
	);
	return true;
}

function finishRun(
	session: ChromeSession,
	result: Omit<BrowserRun, "consoleErrors" | "externalRequests">
): BrowserRun {
	const pageOrigin = new URL(session.requests[0] ?? "http://127.0.0.1").origin;
	const externalRequests = session.requests.filter((request) => {
		const url = new URL(request);
		return url.origin !== pageOrigin && url.protocol !== "data:";
	});

	return {
		...result,
		consoleErrors: session.consoleErrors,
		externalRequests,
	};
}

function makeScenario(
	history: SharedMsg[],
	initialMessages: SharedMsg[],
	pageSize: number
): Scenario {
	return {
		fixture: {
			history: [...history],
			initialMessages: [...initialMessages],
			totalMessages: history.length,
		},
		secondaryMessage: makeMessage(900000),
		pageSize,
	};
}

function compareIds(actual: number[], expected: number[]): IdComparison {
	const missing = expected.filter((id) => !actual.includes(id));
	const expectedSet = new Set(expected);
	const unexpected = actual.filter((id) => !expectedSet.has(id));

	return {
		passed:
			missing.length === 0 &&
			unexpected.length === 0 &&
			duplicates(actual).length === 0 &&
			isStrictlyIncreasing(actual),
		actualCount: actual.length,
		expectedCount: expected.length,
		missing: missing.slice(0, 20),
		unexpected: unexpected.slice(0, 20),
		duplicates: duplicates(actual).slice(0, 20),
		ordered: isStrictlyIncreasing(actual),
	};
}

function duplicates(values: number[]): number[] {
	const seen = new Set<number>();
	const duplicateValues = new Set<number>();

	for (const value of values) {
		if (seen.has(value)) {
			duplicateValues.add(value);
		}

		seen.add(value);
	}

	return [...duplicateValues];
}

function isStrictlyIncreasing(values: number[]): boolean {
	return values.every((value, index) => index === 0 || value > values[index - 1]);
}

function range(first: number, end: number): number[] {
	return Array.from({length: end - first}, (_, index) => first + index);
}

function withoutMessageIds(snapshot: DomSnapshot): Omit<DomSnapshot, "messageIds"> {
	const {messageIds: _, ...rest} = snapshot;
	return rest;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});

	return {promise, resolve, reject};
}

function injectBenchmarkHtml(): string {
	const html = readFileSync(path.join(publicDirectory, "index.html"), "utf8");
	const head = [
		'<link id="theme" rel="stylesheet" href="themes/default.css" data-server-theme="default">',
		'<style id="user-specified-css"></style>',
	].join("\n\t");

	return html
		.replace("</head>", `\t${head}\n\t</head>`)
		.replace(/<!--thelounge-themecolor-->/g, "#415364")
		.replace("<!--thelounge-bodyclass-->", "")
		.replace("<!--thelounge-transports-->", "[&quot;websocket&quot;]");
}

function buildClient(): void {
	const vitePath = path.join(repositoryRoot, "node_modules", ".bin", "vite");
	const result = spawnSync(vitePath, ["build"], {
		cwd: repositoryRoot,
		env: {...process.env, NODE_ENV: "production"},
		stdio: "inherit",
	});

	if (result.status !== 0) {
		throw new Error(`Production client build failed with status ${result.status}`);
	}
}

function parseArguments(argv: string[]): Arguments {
	const result: Arguments = {
		runs: 3,
		chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		cpuRate: 1,
		skipBuild: false,
	};

	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];

		if (argument === "--runs") {
			result.runs = Number(argv[++index]);
		} else if (argument === "--chrome") {
			result.chromePath = argv[++index];
		} else if (argument === "--cpu-rate") {
			result.cpuRate = Number(argv[++index]);
		} else if (argument === "--output") {
			result.outputPath = argv[++index];
		} else if (argument === "--skip-build") {
			result.skipBuild = true;
		} else if (argument === "--scenario") {
			const scenario = argv[++index] as ScenarioName;

			if (!["control", "large-history", "long-session"].includes(scenario)) {
				throw new Error(`Unknown benchmark scenario ${scenario}`);
			}

			result.scenario = scenario;
		} else {
			throw new Error(`Unknown benchmark argument ${argument}`);
		}
	}

	if (!Number.isInteger(result.runs) || result.runs < 1) {
		throw new Error("--runs must be a positive integer");
	}

	if (!Number.isFinite(result.cpuRate) || result.cpuRate < 1) {
		throw new Error("--cpu-rate must be at least 1");
	}

	return result;
}

function summarize(runs: BrowserRun[]): Record<string, any> {
	const control = runs.filter((run) => run.scenario === "control");
	const large = runs.filter((run) => run.scenario === "large-history");
	const long = runs.filter((run) => run.scenario === "long-session");

	return {
		control: {
			interactiveMs: median(control.map((run) => run.phases.initial.durationMs)),
			domNodes: median(control.map((run) => run.dom.initial.descendantElementCount)),
			heapMiB: bytesToMiB(median(control.map((run) => run.heapBytes.initial))),
		},
		largeHistory: {
			loadTo10000Ms: median(large.map((run) => run.phases.loadHistory.durationMs)),
			inputDelayP95Ms: median(large.map((run) => run.input.loadHistory.timerDelay.p95)),
			totalBlockingTimeMs: median(
				large.map((run) => run.phases.loadHistory.totalBlockingTimeMs)
			),
			domNodes: median(large.map((run) => run.dom.at10000.descendantElementCount)),
			renderedMessages: median(large.map((run) => run.dom.at10000.messageCount)),
			heapMiB: bytesToMiB(median(large.map((run) => run.heapBytes.at10000))),
		},
		longSession: {
			bottomBurstMs: median(long.map((run) => run.phases.bottomBurst.durationMs)),
			scrolledBurstMs: median(long.map((run) => run.phases.scrolledBurst.durationMs)),
			inputDelayP95Ms: median(long.map((run) => run.input.scrolledBurst.timerDelay.p95)),
			historyPrependMs: median(long.map((run) => run.phases.historyPrepends.durationMs)),
			channelRoundTripMs: median(long.map((run) => run.phases.channelRoundTrip.durationMs)),
			maxRenderedMessages: median(long.map((run) => run.dom.afterPrepends.messageCount)),
			maxDomNodes: median(long.map((run) => run.dom.afterPrepends.descendantElementCount)),
			maxHeapMiB: bytesToMiB(median(long.map((run) => run.heapBytes.afterPrepends))),
			stabilityHeapDeltaMiB: bytesToMiB(
				median(long.map((run) => run.correctness.stabilityHeapDeltaBytes ?? 0))
			),
		},
	};
}

function median(values: number[]): number {
	if (values.length === 0) {
		return 0;
	}

	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	const value =
		sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
	return Math.round(value * 100) / 100;
}

function bytesToMiB(bytes: number): number {
	return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

const configuration = {
	public: false,
	useHexIp: false,
	prefetch: true,
	fileUpload: false,
	ldapEnabled: false,
	isUpdateAvailable: false,
	applicationServerKey: "",
	version: "benchmark",
	gitCommit: null,
	themes: [{displayName: "Default", name: "default", themeColor: "#415364"}],
	defaultTheme: "default",
	lockNetwork: false,
	defaults: {
		name: "",
		host: "",
		port: 6697,
		password: "",
		tls: true,
		rejectUnauthorized: true,
		nick: "",
		username: "",
		realname: "",
		join: "",
		leaveMessage: "",
		sasl: "",
		saslAccount: "",
		saslPassword: "",
	},
};

async function main(): Promise<void> {
	const args = parseArguments(process.argv.slice(2));

	if (!args.skipBuild) {
		buildClient();
	}

	const host = new BenchmarkHost();
	const pageUrl = await host.start();
	const runs: BrowserRun[] = [];

	try {
		for (let run = 1; run <= args.runs; run++) {
			if (!args.scenario || args.scenario === "control") {
				console.error(`[run ${run}] control: start`);
				runs.push(await runControl(host, pageUrl, args, run));
				console.error(`[run ${run}] control: complete`);
				writeCheckpoint(args, runs);
			}

			if (!args.scenario || args.scenario === "large-history") {
				console.error(`[run ${run}] large-history: start`);
				runs.push(await runLargeHistory(host, pageUrl, args, run));
				console.error(`[run ${run}] large-history: complete`);
				writeCheckpoint(args, runs);
			}

			if (!args.scenario || args.scenario === "long-session") {
				console.error(`[run ${run}] long-session: start`);
				runs.push(await runLongSession(host, pageUrl, args, run));
				console.error(`[run ${run}] long-session: complete`);
				writeCheckpoint(args, runs);
			}
		}
	} finally {
		await host.close();
	}

	const json = writeCheckpoint(args, runs);
	console.log(json);
}

function writeCheckpoint(args: Arguments, runs: BrowserRun[]): string {
	const output = {
		metadata: {
			revision: execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: repositoryRoot,
				encoding: "utf8",
			}).trim(),
			chrome: execFileSync(args.chromePath, ["--version"], {encoding: "utf8"}).trim(),
			node: process.version,
			runs: args.runs,
			cpuRate: args.cpuRate,
			viewport: "1440x900@1x",
			fixture: "deterministic synthetic messages; no production data",
		},
		summary: summarize(runs),
		rawRuns: runs,
	};
	const json = `${JSON.stringify(output, null, 2)}\n`;

	if (args.outputPath) {
		writeFileSync(path.resolve(args.outputPath), json);
	}

	return json;
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

/* eslint-disable no-console */

import {execFileSync, spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {existsSync, readdirSync, readFileSync, statSync, writeFileSync} from "node:fs";
import {createServer, Server as HttpServer} from "node:http";
import path from "node:path";
import express from "express";
import {Server as SocketServer, Socket} from "socket.io";

import {condensedTypes} from "../../shared/irc";
import {MessageType, SharedMsg} from "../../shared/types/msg";
import {SearchQuery} from "../../shared/types/storage";
import {
	CdpClient,
	ChromeSession,
	closeChrome,
	collectHeap,
	delay,
	evaluate,
	launchChrome,
	waitForExpression,
	waitForFunction,
} from "./cdp";
import {
	BenchmarkChannelFixture,
	makeMessage,
	makeMessages,
	makeNetwork,
} from "./clientPerformanceFixtures";

type ScenarioName = "control" | "large-history" | "long-session" | "interactions";
type StatusMessageMode = "condensed" | "hidden" | "shown";

type Arguments = {
	allowValidationFailures: boolean;
	runs: number;
	chromePath: string;
	cpuRate: number;
	inspect: boolean;
	port: number;
	outputPath?: string;
	scenario?: ScenarioName;
	statusMessages: StatusMessageMode;
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
	windowed: boolean;
	retainedCount: number;
	windowStart: number;
	windowEnd: number;
	messageElementCount: number;
	descendantElementCount: number;
	totalElementCount: number;
	bottomOffset: number;
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
	unreadMarkerCount: number;
	unreadMarkerMessageIds: number[];
	dateMarkerCount: number;
	dateMarkerMessageIds: number[];
	role: string | null;
	ariaLive: string | null;
};

type ListenerSnapshot = {
	windowResize: number;
	documentTouch: number;
	messageTouch: number;
};

type StatusModeSnapshot = {
	condensedContainers: number;
	statusRows: number;
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
	visitedWindowStarts: number[];
	maxUnreadMarkerCount: number;
	observedUnreadMarkerIds: number[];
	maxDateMarkerCount: number;
	observedDateMarkerIds: number[];
	dateMarkerLayoutValid: boolean;
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
	listeners: Record<string, ListenerSnapshot>;
	correctness: Correctness;
	consoleErrors: string[];
	externalRequests: string[];
	validation?: {passed: boolean; failures: string[]};
};

type BenchmarkIdentity = {
	productFingerprint: string;
	harnessFingerprint: string;
};

type Scenario = {
	fixture: BenchmarkChannelFixture;
	secondaryMessage: SharedMsg;
	pageSize: number;
	statusMessages: StatusMessageMode;
};

const livePhaseMessageCount = 1599;
const stabilityCycleMessageCount = 600;
const stabilityWarmupCycles = 8;
const stabilityMeasuredCycles = 8;

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
	private historyPagesSent = 0;
	readonly inputEvents: Array<{target: number; text: string; replyTo?: string}> = [];
	readonly searchQueries: SearchQuery[] = [];

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
		this.app.get("/benchmark-image/:id.svg", (request, response) => {
			const id = Number(request.params.id) || 0;
			response
				.type("image/svg+xml")
				.send(
					`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#415364"/><text x="4" y="36" fill="white">${id}</text></svg>`
				);
		});
		this.app.use(express.static(publicDirectory));
		this.sockets.on("connection", (socket) => this.onConnection(socket));
	}

	async start(port = 0): Promise<string> {
		await new Promise<void>((resolve, reject) => {
			this.httpServer.once("error", reject);
			this.httpServer.listen(port, "127.0.0.1", () => resolve());
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
		this.historyPagesSent = 0;
		this.inputEvents.length = 0;
		this.searchQueries.length = 0;
	}

	get historyPageCount(): number {
		return this.historyPagesSent;
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

	emitShowInActive(messages: SharedMsg[]): void {
		const socket = this.requireSocket();

		for (const message of messages) {
			socket.emit("msg", {chan: 3, msg: message, unread: 0, highlight: 0});
		}
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
		socket.on("setting:get", () =>
			socket.emit("setting:all", {
				statusMessages: this.requireScenario().statusMessages,
				searchEnabled: true,
			})
		);
		socket.on("names", ({target}) => socket.emit("names", {id: target, users: []}));
		socket.on("more", ({target, lastId}) => this.sendMore(socket, target, lastId));
		socket.on("input", (event) => this.inputEvents.push(event));
		socket.on("search", (query: SearchQuery) => {
			this.searchQueries.push(query);
			const results = this.requireScenario()
				.fixture.history.filter((message) => message.type === MessageType.MESSAGE)
				.slice(query.offset, query.offset + 12);
			socket.emit("search:results", {...query, results});
		});
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
		this.historyPagesSent++;
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
	const scenario = makeScenario(messages, messages, 100, args.statusMessages);
	host.prepare(scenario);
	const session = await openScenario(host, pageUrl, args, 100);

	try {
		const initial = await initialMetrics(session.cdp);
		const dom = await getDomSnapshot(session.cdp);
		const heap = await collectHeap(session.cdp);
		const statusMode = await getStatusModeSnapshot(session.cdp);
		const reachability = await collectReachableMessages(
			session.cdp,
			expectedVisibleIds(messages, args.statusMessages)
		);
		const statusModeAfterTraversal = await getStatusModeSnapshot(session.cdp);

		return finishRun(session, {
			scenario: "control",
			run,
			phases: {initial},
			input: {},
			dom: {initial: withoutMessageIds(dom)},
			heapBytes: {initial: heap},
			listeners: {initial: await getListenerSnapshot(session.cdp)},
			correctness: {
				reachability,
				bottomAnchored: dom.bottomOffset <= 30,
				accessibility: dom.role === "log" && dom.ariaLive === "polite",
				unreadMarkers:
					reachability.maxUnreadMarkerCount <= 1 &&
					markerObservedExactlyOnce(
						reachability.observedUnreadMarkerIds,
						expectedUnreadMarkerId(messages, messages, args.statusMessages)
					),
				dateMarkers:
					reachability.dateMarkerLayoutValid &&
					markerSetsEqual(
						reachability.observedDateMarkerIds,
						expectedDateMarkerIds(messages, args.statusMessages)
					),
				statusMode: statusModeIsCorrect(statusMode, args.statusMessages),
				statusModeAfterTraversal: statusModeIsCorrect(
					statusModeAfterTraversal,
					args.statusMessages
				),
			},
		});
	} finally {
		await closeChrome(session);
	}
}

async function runInteractions(
	host: BenchmarkHost,
	pageUrl: string,
	args: Arguments,
	run: number
): Promise<BrowserRun> {
	const messages = makeInteractionMessages();
	const scenario = makeScenario(messages, messages, 100, args.statusMessages);
	let focusedMessage = false;
	let focusRemovalReturnsTail = false;
	let focusSessionClean = false;

	host.prepare(scenario);
	const focusSession = await openScenario(
		host,
		`${pageUrl}#/chan-2?focused=100`,
		args,
		messages.at(-1)!.id
	);

	try {
		if (args.statusMessages === "hidden") {
			await waitForWindowStart(focusSession.cdp, 350);
			focusedMessage = await evaluate<boolean>(
				focusSession.cdp,
				`!document.querySelector('#msg-100') && (() => {
					const chat = document.querySelector('#chat .chat');
					return chat.scrollHeight - chat.scrollTop - chat.clientHeight <= 30;
				})()`
			);
		} else {
			await waitForExpression(
				focusSession.cdp,
				"document.querySelector('#msg-100.highlight')",
				30000
			);
			await waitForExpression(
				focusSession.cdp,
				`(() => {
					const message = document.querySelector('#msg-100');
					const chat = document.querySelector('#chat .chat');

					if (!message || !chat) {
						return false;
					}

					const center = message.getBoundingClientRect().top + message.getBoundingClientRect().height / 2;
					const chatCenter = chat.getBoundingClientRect().top + chat.clientHeight / 2;
					return Math.abs(center - chatCenter) <= chat.clientHeight / 3;
				})()`,
				30000
			);
			focusedMessage = await evaluate<boolean>(
				focusSession.cdp,
				`(() => {
					const message = document.querySelector('#msg-100');
					const chat = document.querySelector('#chat .chat');
					const center = message.getBoundingClientRect().top + message.getBoundingClientRect().height / 2;
					const chatCenter = chat.getBoundingClientRect().top + chat.clientHeight / 2;
					return Math.abs(center - chatCenter) <= chat.clientHeight / 3;
				})()`
			);
		}

		await setChannelHash(focusSession.cdp, 2);
		await waitForRetainedCount(focusSession.cdp, 100, 30000);
		await waitForWindowStart(focusSession.cdp, 0);
		focusRemovalReturnsTail = await isBottomAnchored(focusSession.cdp);
		focusSessionClean = focusSession.consoleErrors.length === 0;
	} finally {
		await closeChrome(focusSession);
	}

	console.error(`[run ${run}] interactions: focused-route flow complete`);

	host.prepare(scenario);
	const session = await openScenario(host, pageUrl, args, messages.at(-1)!.id);

	try {
		const initial = await initialMetrics(session.cdp);
		const initialDom = await getDomSnapshot(session.cdp);
		const correctness: Correctness = {
			statusMode: statusModeIsCorrect(
				await getStatusModeSnapshot(session.cdp),
				args.statusMessages
			),
			accessibility:
				initialDom.role === "log" &&
				initialDom.ariaLive === "polite" &&
				initialDom.windowed,
			focusedMessage: focusedMessage && focusSessionClean,
			focusRemovalReturnsTail,
		};

		const beforeOlderWindow = await getDomSnapshot(session.cdp);
		await scrollToTop(session.cdp);
		const olderAnchor = await getFirstVisibleAnchor(session.cdp);
		const olderButtonAccessible = await evaluate<boolean>(
			session.cdp,
			`(() => {
			const button = document.querySelector('[data-message-window="older"] button');
			return button?.tagName === 'BUTTON' && button.textContent.includes('Show older loaded messages');
		})()`
		);
		await focusSelectorWithoutScroll(session.cdp, '[data-message-window="older"] button');
		await pressKey(session.cdp, "Enter");
		await waitForExpression(
			session.cdp,
			`document.querySelector('#chat .messages')?.getAttribute('data-window-start') !== '${beforeOlderWindow.windowStart}'`,
			30000
		);
		const olderKeyboardFocus = await evaluate<boolean>(
			session.cdp,
			`document.activeElement === document.querySelector('[data-message-window="older"] button')`
		);
		const afterOlderWindow = await getDomSnapshot(session.cdp);
		const olderAnchorError = await getAnchorError(session.cdp, olderAnchor);
		await scrollToTop(session.cdp);
		await clickSelector(session.cdp, '[data-message-window="older"] button');
		await waitForWindowStart(session.cdp, afterOlderWindow.windowStart - 125);
		await scrollToWindowBottom(session.cdp);
		const newerAnchor = await getLastVisibleAnchor(session.cdp);
		await focusSelectorWithoutScroll(session.cdp, '[data-message-window="newer"] button');
		await pressKey(session.cdp, "Space");
		await waitForWindowStart(session.cdp, afterOlderWindow.windowStart);
		const newerKeyboardFocus = await evaluate<boolean>(
			session.cdp,
			`document.activeElement === document.querySelector('[data-message-window="newer"] button')`
		);
		const newerAnchorError = await getAnchorError(session.cdp, newerAnchor);
		await clickSelector(session.cdp, '[data-message-window="newer"] button');
		await waitForWindowStart(session.cdp, beforeOlderWindow.windowStart);
		correctness.windowAnchorErrorPx = olderAnchorError;
		correctness.windowNewerAnchorErrorPx = newerAnchorError;
		correctness.windowStartDelta = afterOlderWindow.windowStart - beforeOlderWindow.windowStart;
		correctness.keyboardWindowControls = olderKeyboardFocus && newerKeyboardFocus;
		correctness.windowControlNavigation =
			olderButtonAccessible &&
			afterOlderWindow.windowStart === beforeOlderWindow.windowStart - 125 &&
			olderAnchorError <= 1 &&
			newerAnchorError <= 1 &&
			(await isBottomAnchored(session.cdp));

		await scrollToTop(session.cdp);
		await clickSelector(session.cdp, '[data-message-window="older"] button');
		await waitForWindowStart(session.cdp, beforeOlderWindow.windowStart - 125);
		const beforeNoopReconnect = await getDomSnapshot(session.cdp);
		const noopReconnectAnchor = await getFirstVisibleAnchor(session.cdp);
		host.emitReconnect([]);
		await delay(100);
		await twoAnimationFrames(session.cdp);
		const afterNoopReconnect = await getDomSnapshot(session.cdp);
		correctness.noopReconnectPreservesWindow =
			compareIds(afterNoopReconnect.messageIds, beforeNoopReconnect.messageIds).passed &&
			afterNoopReconnect.windowStart === beforeNoopReconnect.windowStart &&
			(await getAnchorError(session.cdp, noopReconnectAnchor)) <= 1;
		await jumpToBottom(session.cdp);
		await waitForWindowStart(session.cdp, beforeOlderWindow.windowStart);
		console.error(`[run ${run}] interactions: window controls complete`);

		if (args.statusMessages === "condensed") {
			await focusSelectorWithoutScroll(
				session.cdp,
				'#chat .msg.closed[data-type="condensed"] .toggle-button'
			);
			await pressKey(session.cdp, "Enter");
			await waitForExpression(
				session.cdp,
				`document.querySelector('#chat .msg[data-type="condensed"] .toggle-button[aria-expanded="true"]')`,
				10000
			);
			const expandedKeyboardFocus = await evaluate<boolean>(
				session.cdp,
				`document.activeElement === document.querySelector(
				'#chat .msg:not(.closed)[data-type="condensed"] .toggle-button'
			)`
			);
			await pressKey(session.cdp, "Space");
			await waitForExpression(
				session.cdp,
				`document.querySelector('#chat .msg.closed[data-type="condensed"] .toggle-button[aria-expanded="false"]')`,
				10000
			);
			const collapsedKeyboardFocus = await evaluate<boolean>(
				session.cdp,
				`document.activeElement === document.querySelector(
				'#chat .msg.closed[data-type="condensed"] .toggle-button'
			)`
			);
			correctness.condensedControl = expandedKeyboardFocus && collapsedKeyboardFocus;
		} else {
			correctness.condensedControl =
				(await getStatusModeSnapshot(session.cdp)).condensedContainers === 0;
		}

		console.error(`[run ${run}] interactions: status controls complete`);

		await focusSelector(session.cdp, '#msg-596 .reply-context[role="button"]');
		const replyContextAccessible = await evaluate<boolean>(
			session.cdp,
			`document.activeElement?.getAttribute('tabindex') === '0' &&
				document.activeElement?.classList.contains('disabled') === false`
		);
		await clickSelector(session.cdp, '#msg-596 .reply-context[role="button"]');
		await waitForExpression(session.cdp, "document.querySelector('#msg-110.highlight')", 30000);
		await waitForExpression(
			session.cdp,
			`(() => {
				const message = document.querySelector('#msg-110');
				const chat = document.querySelector('#chat .chat');

				if (!message || !chat) {
					return false;
				}

				const center = message.getBoundingClientRect().top + message.getBoundingClientRect().height / 2;
				const chatCenter = chat.getBoundingClientRect().top + chat.clientHeight / 2;
				return Math.abs(center - chatCenter) <= chat.clientHeight / 3;
			})()`,
			30000
		);
		const parentCentered = await evaluate<boolean>(
			session.cdp,
			`(() => {
				const message = document.querySelector('#msg-110');
				const chat = document.querySelector('#chat .chat');
				const center = message.getBoundingClientRect().top + message.getBoundingClientRect().height / 2;
				const chatCenter = chat.getBoundingClientRect().top + chat.clientHeight / 2;
				return Math.abs(center - chatCenter) <= chat.clientHeight / 3;
			})()`
		);
		correctness.replyParentNavigation = replyContextAccessible && parentCentered;
		await jumpToBottom(session.cdp);
		await waitForWindowStart(session.cdp, 350);

		await clickSelector(session.cdp, "#msg-596 .msg-action-reply");
		await waitForExpression(session.cdp, "document.querySelector('.reply-bar')", 10000);
		const replyBarAccessible = await evaluate<boolean>(
			session.cdp,
			`document.activeElement?.id === 'input' &&
				document.querySelector('.reply-bar-close')?.getAttribute('aria-label') === 'Cancel reply'`
		);
		const replyBarBottomAnchored = await isBottomAnchored(session.cdp);
		await clickSelector(session.cdp, ".reply-bar-close");
		await waitForExpression(session.cdp, "!document.querySelector('.reply-bar')", 10000);
		const replyCancelBottomAnchored = await isBottomAnchored(session.cdp);

		await evaluate(
			session.cdp,
			"document.querySelector('#msg-596 .msg-action-reply')?.click()"
		);
		await waitForExpression(session.cdp, "document.querySelector('.reply-bar')", 10000);
		await replaceText(session.cdp, "#input", "benchmark reply");
		await clickSelector(session.cdp, "#submit");
		await waitForHostCondition(() => host.inputEvents.length >= 1);
		const replyInput = host.inputEvents[0];
		const replySent =
			replyInput.target === 2 &&
			replyInput.text === "benchmark reply" &&
			replyInput.replyTo === "bench-596";
		correctness.replyComposer =
			replyBarAccessible &&
			replyBarBottomAnchored &&
			replyCancelBottomAnchored &&
			replySent &&
			(await isBottomAnchored(session.cdp));
		console.error(`[run ${run}] interactions: reply flows complete`);

		await waitForExpression(
			session.cdp,
			"document.querySelector('#msg-587 .preview .more')",
			10000
		);
		await clickSelector(session.cdp, "#msg-587 .preview .more");
		await waitForExpression(
			session.cdp,
			`document.querySelector('#msg-587 .preview .more')?.getAttribute('aria-expanded') === 'true'`,
			10000
		);
		const previewBottomAnchored = await isBottomAnchored(session.cdp);
		await clickSelector(session.cdp, "#msg-587 .preview .more");
		await waitForExpression(
			session.cdp,
			`document.querySelector('#msg-587 .preview .more')?.getAttribute('aria-expanded') === 'false'`,
			10000
		);
		await evaluate(
			session.cdp,
			`(() => {
				const chat = document.querySelector('#chat .chat');
				chat.scrollTop = Math.max(0, chat.scrollTop - 200);
				chat.dispatchEvent(new Event('scroll'));
			})()`
		);
		await waitForExpression(
			session.cdp,
			"Boolean(document.querySelector('#chat .scroll-down-shown'))",
			10000
		);
		const previewAnchor = await getFirstVisibleAnchor(session.cdp);
		await clickSelector(session.cdp, "#msg-587 .preview .more");
		await waitForExpression(
			session.cdp,
			`document.querySelector('#msg-587 .preview .more')?.getAttribute('aria-expanded') === 'true'`,
			10000
		);
		const previewScrolledAnchorError = await getAnchorError(session.cdp, previewAnchor);
		const previewRemainedScrolledUp = await evaluate<boolean>(
			session.cdp,
			"Boolean(document.querySelector('#chat .scroll-down-shown'))"
		);
		correctness.previewBottomAnchored = previewBottomAnchored;
		correctness.previewScrolledAnchorErrorPx = previewScrolledAnchorError;
		correctness.previewRemainedScrolledUp = previewRemainedScrolledUp;
		correctness.linkPreviewAnchoring =
			previewBottomAnchored && previewScrolledAnchorError <= 1 && previewRemainedScrolledUp;
		await jumpToBottom(session.cdp);
		console.error(`[run ${run}] interactions: preview flow complete`);

		await waitForExpression(
			session.cdp,
			`document.querySelector('#msg-590 .toggle-thumbnail img')?.offsetParent !== null`,
			10000
		);
		await clickSelector(session.cdp, "#msg-590 .toggle-thumbnail");
		await waitForExpression(
			session.cdp,
			"document.querySelector('#image-viewer.opened')",
			10000
		);
		const image590 = await viewerShowsImage(session.cdp, 590);
		await clickSelector(session.cdp, "#image-viewer .previous-image-btn");
		await waitForViewerImage(session.cdp, 350);
		const image350 = await viewerShowsImage(session.cdp, 350);
		await clickSelector(session.cdp, "#image-viewer .previous-image-btn");
		await waitForViewerImage(session.cdp, 110);
		const image110 = await viewerShowsImage(session.cdp, 110);
		await clickSelector(session.cdp, "#image-viewer .next-image-btn");
		await waitForViewerImage(session.cdp, 350);
		await clickSelector(session.cdp, "#image-viewer .close-btn");
		await waitForExpression(
			session.cdp,
			"!document.querySelector('#image-viewer.opened')",
			10000
		);
		correctness.imageNavigation = image590 && image350 && image110;
		console.error(`[run ${run}] interactions: image flow complete`);

		await replaceText(session.cdp, "#input", "draft A");
		await switchChannel(session.cdp, 3, scenario.secondaryMessage.id);
		const secondaryStartedEmpty =
			(await evaluate<string>(session.cdp, "document.querySelector('#input').value")) === "";
		const inputsBeforeSecondary = host.inputEvents.length;
		await replaceText(session.cdp, "#input", "sent one");
		await evaluate(session.cdp, "document.querySelector('#submit')?.click()");
		await waitForHostCondition(() => host.inputEvents.length === inputsBeforeSecondary + 1);
		await replaceText(session.cdp, "#input", "sent two");
		await evaluate(session.cdp, "document.querySelector('#submit')?.click()");
		await waitForHostCondition(() => host.inputEvents.length === inputsBeforeSecondary + 2);
		await focusSelector(session.cdp, "#input");
		await pressKey(session.cdp, "ArrowUp");
		const historyTwo = await getInputValue(session.cdp);
		await pressKey(session.cdp, "ArrowUp");
		const historyOne = await getInputValue(session.cdp);
		await pressKey(session.cdp, "ArrowDown");
		const historyForward = await getInputValue(session.cdp);
		await pressKey(session.cdp, "ArrowDown");
		const historyDraft = await getInputValue(session.cdp);
		await replaceText(session.cdp, "#input", "draft B");
		await switchChannel(session.cdp, 2, 600);
		const restoredDraftA = (await getInputValue(session.cdp)) === "draft A";
		await switchChannel(session.cdp, 3, scenario.secondaryMessage.id);
		const restoredDraftB = (await getInputValue(session.cdp)) === "draft B";
		await switchChannel(session.cdp, 2, 600);
		const secondaryInputs = host.inputEvents.filter((event) => event.target === 3);
		correctness.inputHistoryAndDrafts =
			secondaryStartedEmpty &&
			historyTwo === "sent two" &&
			historyOne === "sent one" &&
			historyForward === "sent two" &&
			historyDraft === "" &&
			restoredDraftA &&
			restoredDraftB &&
			secondaryInputs.length === 2 &&
			secondaryInputs[0].text === "sent one" &&
			secondaryInputs[1].text === "sent two";
		console.error(`[run ${run}] interactions: input flows complete`);

		await clickSelector(session.cdp, ".message-search .search");
		await waitForExpression(
			session.cdp,
			"document.activeElement?.matches('.message-search input')",
			10000
		);
		await replaceText(session.cdp, ".message-search input", "Synthetic");
		await evaluate(session.cdp, "document.querySelector('.message-search')?.requestSubmit()");
		await waitForExpression(
			session.cdp,
			"document.querySelector('[data-type=\"search-results\"] .result')",
			30000
		);
		await waitForHostCondition(() => host.searchQueries.length >= 1);
		const searchQuery = host.searchQueries[0];
		const expectedSearchIds = messages
			.filter((message) => message.type === MessageType.MESSAGE)
			.slice(0, 12)
			.map((message) => message.id);
		const searchState = await evaluate<{ids: number[]; accessible: boolean}>(
			session.cdp,
			`(() => ({
				ids: [...document.querySelectorAll('[data-type="search-results"] .result .msg')]
					.map((message) => Number(message.id.slice(4))),
				accessible:
					document.querySelector('[data-type="search-results"]')?.getAttribute('role') === 'tabpanel' &&
					document.querySelector('[data-type="search-results"]')?.getAttribute('aria-label') === 'Search results' &&
					document.querySelector('[data-type="search-results"] .messages')?.getAttribute('role') === 'log' &&
					document.querySelector('[data-type="search-results"] .close')?.getAttribute('aria-label') === 'Close search window'
			}))()`
		);
		correctness.search =
			searchQuery.networkUuid === "benchmark-network" &&
			searchQuery.channelName === "#benchmark" &&
			searchQuery.searchTerm === "Synthetic" &&
			searchQuery.offset === 0 &&
			searchState.accessible &&
			compareIds(searchState.ids, expectedSearchIds).passed;
		await clickSelector(session.cdp, '[data-type="search-results"] .close');
		await waitForExpression(session.cdp, "document.querySelector('#chat .messages')", 10000);
		console.error(`[run ${run}] interactions: search flow complete`);

		const activeParent = makeMessage(604);
		activeParent.showInActive = true;
		activeParent.text = "Synthetic showInActive parent";
		const activeReply = makeMessage(606);
		activeReply.showInActive = true;
		activeReply.replyTo = activeParent.msgid;
		activeReply.replyToNick = activeParent.from?.nick;
		activeReply.replyToText = activeParent.text;
		host.emitShowInActive([activeParent, activeReply]);
		await waitForRetainedLastId(session.cdp, activeReply.id, 30000);
		const activeShowInActiveState = await evaluate<boolean>(
			session.cdp,
			`Boolean(document.querySelector('#chan-2 #msg-604')) &&
				Boolean(document.querySelector('#chan-2 #msg-606')) &&
				document.querySelector('#chan-2 #msg-606 .reply-context')?.classList.contains('disabled') === false`
		);
		await switchChannel(session.cdp, 3, scenario.secondaryMessage.id);
		const sourceShowInActiveState = await evaluate<boolean>(
			session.cdp,
			`!document.querySelector('#chan-3 #msg-604') && !document.querySelector('#chan-3 #msg-606')`
		);
		await switchChannel(session.cdp, 2, activeReply.id);
		const returnedShowInActiveDom = await getDomSnapshot(session.cdp);
		correctness.showInActive =
			activeShowInActiveState &&
			sourceShowInActiveState &&
			returnedShowInActiveDom.retainedCount === 100 &&
			returnedShowInActiveDom.messageIds.includes(activeParent.id) &&
			returnedShowInActiveDom.messageIds.includes(activeReply.id) &&
			(await isBottomAnchored(session.cdp));
		console.error(`[run ${run}] interactions: showInActive flow complete`);

		const finalDom = await getDomSnapshot(session.cdp);
		correctness.finalState =
			finalDom.retainedCount === 100 &&
			finalDom.windowEnd - finalDom.windowStart <= 250 &&
			(await isBottomAnchored(session.cdp));

		return finishRun(session, {
			scenario: "interactions",
			run,
			phases: {initial},
			input: {},
			dom: {
				initial: withoutMessageIds(initialDom),
				final: withoutMessageIds(finalDom),
			},
			heapBytes: {final: await collectHeap(session.cdp)},
			listeners: {final: await getListenerSnapshot(session.cdp)},
			correctness,
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
	const scenario = makeScenario(history, initialMessages, 1000, args.statusMessages);
	host.prepare(scenario);
	const session = await openScenario(host, pageUrl, args, 10000);

	try {
		const initial = await initialMetrics(session.cdp);
		const heapAt100 = await collectHeap(session.cdp);
		await scrollToTop(session.cdp);
		const startedAt = await resetMetrics(session.cdp);
		await startInputProbe(session.cdp);
		const anchorErrors: number[] = [];

		while (host.historyPageCount < 10) {
			await scrollToTop(session.cdp);
			const isHistoryRequest = await olderButtonLoadsHistory(session.cdp);
			const anchor = await getFirstVisibleAnchor(session.cdp);
			const changed = await clickWindowButton(session.cdp, "older");

			if (!changed) {
				throw new Error("Older history became unreachable while loading 10,000 messages");
			}

			await waitForHistoryIdle(session.cdp);

			if (isHistoryRequest && anchor) {
				const current = await getMessageOffset(session.cdp, anchor.id);

				if (current !== null) {
					const error = Math.abs(current - anchor.offset);
					anchorErrors.push(error);
					console.error(`[history] anchor ${anchor.id}: ${error.toFixed(3)}px`);
				}
			}
		}

		const input = await stopInputProbe(session.cdp);
		const loadHistory = await finishPhase(session.cdp, startedAt);
		const dom = await getDomSnapshot(session.cdp);
		const statusMode = await getStatusModeSnapshot(session.cdp);
		console.error(`[run ${run}] large-history: rendered ${dom.messageCount} messages`);
		const heapAt10000 = await collectHeap(session.cdp);
		const reachability = await collectReachableMessages(
			session.cdp,
			expectedVisibleIds(history, args.statusMessages),
			120
		);
		const statusModeAfterTraversal = await getStatusModeSnapshot(session.cdp);

		return finishRun(session, {
			scenario: "large-history",
			run,
			phases: {initial, loadHistory},
			input: {loadHistory: input},
			dom: {at10000: withoutMessageIds(dom)},
			heapBytes: {at100: heapAt100, at10000: heapAt10000},
			listeners: {at10000: await getListenerSnapshot(session.cdp)},
			correctness: {
				reachability,
				ordered: isStrictlyIncreasing(dom.messageIds),
				duplicateIds: duplicates(dom.messageIds).slice(0, 20),
				prependAnchorErrorsPx: anchorErrors,
				maxPrependAnchorErrorPx: Math.max(0, ...anchorErrors),
				accessibility: dom.role === "log" && dom.ariaLive === "polite",
				unreadMarkers:
					reachability.maxUnreadMarkerCount <= 1 &&
					markerObservedExactlyOnce(
						reachability.observedUnreadMarkerIds,
						expectedUnreadMarkerId(history, initialMessages, args.statusMessages)
					),
				dateMarkers:
					reachability.dateMarkerLayoutValid &&
					markerSetsEqual(
						reachability.observedDateMarkerIds,
						expectedDateMarkerIds(history, args.statusMessages)
					),
				statusMode: statusModeIsCorrect(statusMode, args.statusMessages),
				statusModeAfterTraversal: statusModeIsCorrect(
					statusModeAfterTraversal,
					args.statusMessages
				),
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
	const scenario = makeScenario(history, initialMessages, 1000, args.statusMessages);
	host.prepare(scenario);
	const session = await openScenario(host, pageUrl, args, 11000);

	try {
		const phases: Record<string, PhaseMetrics> = {initial: await initialMetrics(session.cdp)};
		const input: Record<string, InputMetrics> = {};
		const dom: Record<string, Omit<DomSnapshot, "messageIds">> = {};
		const heapBytes: Record<string, number> = {initial: await collectHeap(session.cdp)};
		const listeners: Record<string, ListenerSnapshot> = {
			initial: await getListenerSnapshot(session.cdp),
		};
		const correctness: Correctness = {};
		correctness.statusMode = statusModeIsCorrect(
			await getStatusModeSnapshot(session.cdp),
			args.statusMessages
		);
		let loadedHistoryFirstId = 0;

		let nextId = 11001;
		let startedAt = await resetMetrics(session.cdp);
		await startInputProbe(session.cdp);
		await emitInBursts(host, makeMessages(nextId, livePhaseMessageCount));
		nextId += livePhaseMessageCount;
		await waitForRetainedLastId(session.cdp, nextId - 1, 120000);
		input.bottomBurst = await stopInputProbe(session.cdp);
		phases.bottomBurst = await finishPhase(session.cdp, startedAt);
		const bottomDom = await getDomSnapshot(session.cdp);
		dom.afterBottomBurst = withoutMessageIds(bottomDom);
		heapBytes.afterBottomBurst = await collectHeap(session.cdp);
		correctness.bottomRetention = await collectReachableMessages(
			session.cdp,
			expectedRange(nextId - 1500, nextId, args.statusMessages),
			20
		);
		loadedHistoryFirstId = nextId - 1500;
		correctness.bottomAnchored = bottomDom.bottomOffset <= 30;
		correctness.statusModeAfterBottomBurst = statusModeIsCorrect(
			await getStatusModeSnapshot(session.cdp),
			args.statusMessages
		);
		console.error(`[run ${run}] long-session: bottom burst complete`);

		await jumpToBottom(session.cdp);
		correctness.scrollEventsNeeded = await scrollUp(session.cdp);
		const scrolledAnchor = await getFirstVisibleAnchor(session.cdp);
		const scrolledWindowBefore = await getDomSnapshot(session.cdp);
		startedAt = await resetMetrics(session.cdp);
		await startInputProbe(session.cdp);
		await emitInBursts(host, makeMessages(nextId, livePhaseMessageCount));
		nextId += livePhaseMessageCount;
		await waitForRetainedCount(session.cdp, 1500 + livePhaseMessageCount, 120000);
		await waitForRetainedLastId(session.cdp, nextId - 1, 120000);
		input.scrolledBurst = await stopInputProbe(session.cdp);
		phases.scrolledBurst = await finishPhase(session.cdp, startedAt);
		const scrolledDom = await getDomSnapshot(session.cdp);
		dom.afterScrolledBurst = withoutMessageIds(scrolledDom);
		heapBytes.afterScrolledBurst = await collectHeap(session.cdp);
		correctness.scrolledOrder = isStrictlyIncreasing(scrolledDom.messageIds);
		correctness.scrolledWindowPreserved = compareIds(
			scrolledDom.messageIds,
			scrolledWindowBefore.messageIds
		);
		correctness.scrolledAnchorErrorPx = await getAnchorError(session.cdp, scrolledAnchor);
		correctness.scrolledMessagesReachable = await collectReachableMessages(
			session.cdp,
			expectedRange(loadedHistoryFirstId, nextId, args.statusMessages),
			30
		);
		correctness.statusModeAfterScrolledBurst = statusModeIsCorrect(
			await getStatusModeSnapshot(session.cdp),
			args.statusMessages
		);
		console.error(`[run ${run}] long-session: scrolled burst complete`);

		startedAt = await resetMetrics(session.cdp);
		const anchorErrors: number[] = [];

		for (let page = 0; page < 2; page++) {
			const result = await loadOneHistoryPage(host, session.cdp);
			loadedHistoryFirstId = Math.max(1, loadedHistoryFirstId - result.loadedCount);
			anchorErrors.push(result.anchorError);
		}

		phases.historyPrepends = await finishPhase(session.cdp, startedAt);
		const prependedDom = await getDomSnapshot(session.cdp);
		dom.afterPrepends = withoutMessageIds(prependedDom);
		heapBytes.afterPrepends = await collectHeap(session.cdp);
		correctness.maxPrependAnchorErrorPx = Math.max(0, ...anchorErrors);
		correctness.prependAnchorErrorsPx = anchorErrors;
		const loadedHistoryReachability = await collectReachableMessages(
			session.cdp,
			expectedRange(loadedHistoryFirstId, nextId, args.statusMessages),
			80
		);
		correctness.loadedHistory = loadedHistoryReachability;
		const loadedMessages = makeMessages(loadedHistoryFirstId, nextId - loadedHistoryFirstId);
		correctness.loadedHistoryMarkers =
			loadedHistoryReachability.maxUnreadMarkerCount <= 1 &&
			loadedHistoryReachability.dateMarkerLayoutValid &&
			markerObservedExactlyOnce(
				loadedHistoryReachability.observedUnreadMarkerIds,
				expectedUnreadMarkerId(loadedMessages, initialMessages, args.statusMessages)
			) &&
			markerSetsEqual(
				loadedHistoryReachability.observedDateMarkerIds,
				expectedDateMarkerIds(loadedMessages, args.statusMessages)
			);
		correctness.statusModeAfterHistory = statusModeIsCorrect(
			await getStatusModeSnapshot(session.cdp),
			args.statusMessages
		);
		console.error(`[run ${run}] long-session: history prepends complete`);

		startedAt = await resetMetrics(session.cdp);
		await switchChannel(session.cdp, 3, scenario.secondaryMessage.id);
		await switchChannel(session.cdp, 2, nextId - 1);
		phases.channelRoundTrip = await finishPhase(session.cdp, startedAt);
		const switchedDom = await getDomSnapshot(session.cdp);
		dom.afterSwitch = withoutMessageIds(switchedDom);
		heapBytes.afterSwitch = await collectHeap(session.cdp);
		listeners.afterSwitch = await getListenerSnapshot(session.cdp);
		correctness.switchTrim = await collectReachableMessages(
			session.cdp,
			expectedRange(nextId - 100, nextId, args.statusMessages),
			5
		);
		correctness.statusModeAfterSwitch = statusModeIsCorrect(
			await getStatusModeSnapshot(session.cdp),
			args.statusMessages
		);

		const reconnectMessages = makeMessages(nextId, 64);
		startedAt = await resetMetrics(session.cdp);
		host.emitReconnect(reconnectMessages);
		nextId += reconnectMessages.length;
		await waitForRetainedLastId(session.cdp, nextId - 1, 120000);
		phases.reconnectMerge = await finishPhase(session.cdp, startedAt);
		const reconnectDom = await getDomSnapshot(session.cdp);
		dom.afterReconnect = withoutMessageIds(reconnectDom);
		correctness.reconnectMerge = await collectReachableMessages(
			session.cdp,
			expectedRange(nextId - reconnectMessages.length - 100, nextId, args.statusMessages)
		);
		correctness.statusModeAfterReconnect = statusModeIsCorrect(
			await getStatusModeSnapshot(session.cdp),
			args.statusMessages
		);
		console.error(`[run ${run}] long-session: switch and reconnect complete`);

		const stabilityHeaps: number[] = [];
		const stabilityDomCounts: number[] = [];
		const stabilityDomNodes: number[] = [];
		const stabilityListeners: ListenerSnapshot[] = [];
		let stabilityStatusMode = true;
		let stabilityBaselineDom: DomSnapshot | undefined;
		let stabilityBaselineListeners: ListenerSnapshot | undefined;

		for (let cycle = 0; cycle < stabilityWarmupCycles + stabilityMeasuredCycles; cycle++) {
			await jumpToBottom(session.cdp);
			await emitInBursts(host, makeMessages(nextId, stabilityCycleMessageCount), 5);
			nextId += stabilityCycleMessageCount;
			await waitForRetainedLastId(session.cdp, nextId - 1, 120000);
			await navigateChannelHistory(session.cdp, "back", 3, scenario.secondaryMessage.id);
			await navigateChannelHistory(session.cdp, "forward", 2, nextId - 1);
			const cycleDom = await getDomSnapshot(session.cdp);

			if (cycle === stabilityWarmupCycles - 1) {
				stabilityBaselineDom = cycleDom;
				stabilityBaselineListeners = await getListenerSnapshot(session.cdp);
				dom.stabilityBaseline = withoutMessageIds(cycleDom);
				listeners.stabilityBaseline = stabilityBaselineListeners;
			}

			if (cycle >= stabilityWarmupCycles) {
				const measuredCycle = cycle - stabilityWarmupCycles + 1;
				dom[`stabilityCycle${measuredCycle}`] = withoutMessageIds(cycleDom);
				stabilityDomCounts.push(cycleDom.messageCount);
				stabilityDomNodes.push(cycleDom.descendantElementCount);
				stabilityListeners.push(await getListenerSnapshot(session.cdp));
				stabilityStatusMode &&= statusModeIsCorrect(
					await getStatusModeSnapshot(session.cdp),
					args.statusMessages
				);
				stabilityHeaps.push(await collectSettledHeap(session.cdp));
			}

			console.error(`[run ${run}] long-session: stability cycle ${cycle + 1} complete`);
		}

		stabilityHeaps.forEach((heap, index) => {
			heapBytes[`stabilityCycle${index + 1}`] = heap;
		});
		correctness.stabilityDomCounts = stabilityDomCounts;
		correctness.stabilityDomNodes = stabilityDomNodes;
		correctness.stabilityDomStable =
			Boolean(stabilityBaselineDom) &&
			stabilityDomNodes.every(
				(count) => count === stabilityBaselineDom!.descendantElementCount
			) &&
			stabilityDomCounts.every((count) => count === stabilityBaselineDom!.messageCount);
		correctness.monotonicHeapGrowth = stabilityHeaps.every(
			(heap, index) => index === 0 || heap > stabilityHeaps[index - 1]
		);
		correctness.stabilityHeapDeltaBytes = stabilityHeaps.at(-1)! - stabilityHeaps[0];
		correctness.stabilityHeapSpreadBytes =
			Math.max(...stabilityHeaps) - Math.min(...stabilityHeaps);
		const earlyHeapMedian = median(stabilityHeaps.slice(0, stabilityHeaps.length / 2));
		const lateHeapMedian = median(stabilityHeaps.slice(stabilityHeaps.length / 2));
		const heapTolerance = Math.max(512 * 1024, earlyHeapMedian * 0.02);
		const heapSlope = linearSlope(stabilityHeaps);
		correctness.stabilityHeapEarlyMedianBytes = earlyHeapMedian;
		correctness.stabilityHeapLateMedianBytes = lateHeapMedian;
		correctness.stabilityHeapSlopeBytesPerCycle = heapSlope;
		correctness.stabilityHeapToleranceBytes = heapTolerance;
		correctness.stabilityHeapPlateau =
			correctness.monotonicHeapGrowth === false &&
			lateHeapMedian - earlyHeapMedian <= heapTolerance &&
			heapSlope <= heapTolerance / (stabilityHeaps.length - 1);
		correctness.stabilityListenersStable =
			Boolean(stabilityBaselineListeners) &&
			stabilityListeners.every((snapshot) =>
				listenerSnapshotsEqual(snapshot, stabilityBaselineListeners!)
			);
		correctness.statusModeDuringStability = stabilityStatusMode;
		stabilityListeners.forEach((snapshot, index) => {
			listeners[`stabilityCycle${index + 1}`] = snapshot;
		});

		return finishRun(session, {
			scenario: "long-session",
			run,
			phases,
			input,
			dom,
			heapBytes,
			listeners,
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
		waitForRetainedLastId(session.cdp, lastMessageId, 120000),
		waitForExpression(session.cdp, "document.querySelector('#input')", 120000),
		waitForExpression(session.cdp, statusModeReadyExpression(args.statusMessages), 120000),
	]);
	return session;
}

function statusModeReadyExpression(statusMessages: StatusMessageMode): string {
	const statusSelector = [...condensedTypes]
		.map((type) => `#chat .msg[data-type="${type}"]`)
		.join(", ");

	return `(() => {
		const messages = document.querySelector('#chat .messages');
		const configured = messages?.getAttribute('data-status-messages');
		if (configured !== null && configured !== undefined) {
			return configured === '${statusMessages}';
		}
		const condensed = document.querySelectorAll('#chat [data-type="condensed"]').length;
		const statusRows = document.querySelectorAll(${JSON.stringify(statusSelector)}).length;
		${
			statusMessages === "condensed"
				? "return condensed > 0;"
				: statusMessages === "hidden"
				? "return condensed === 0 && statusRows === 0;"
				: "return condensed === 0 && statusRows > 0;"
		}
	})()`;
}

async function setChannelHash(cdp: CdpClient, channelId: number, focused?: number): Promise<void> {
	const hash = `#/chan-${channelId}${focused === undefined ? "" : `?focused=${focused}`}`;
	await evaluate(cdp, `location.hash = ${JSON.stringify(hash)}`);
	await waitForExpression(cdp, `location.hash === ${JSON.stringify(hash)}`, 10000);
}

async function waitForWindowStart(cdp: CdpClient, start: number): Promise<void> {
	await waitForExpression(
		cdp,
		`document.querySelector('#chat .messages')?.getAttribute('data-window-start') === '${start}'`,
		30000
	);
	await twoAnimationFrames(cdp);
}

async function isBottomAnchored(cdp: CdpClient): Promise<boolean> {
	return evaluate<boolean>(
		cdp,
		`(() => {
			const chat = document.querySelector('#chat .chat');
			return Boolean(chat) && chat.scrollHeight - chat.scrollTop - chat.clientHeight <= 30;
		})()`
	);
}

async function twoAnimationFrames(cdp: CdpClient): Promise<void> {
	await evaluate(
		cdp,
		"new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
	);
}

async function focusSelector(cdp: CdpClient, selector: string): Promise<void> {
	await evaluate(
		cdp,
		`(() => {
			const element = document.querySelector(${JSON.stringify(selector)});
			if (!element) {
				throw new Error(${JSON.stringify(`Could not focus ${selector}`)});
			}
			element.scrollIntoView({block: 'center'});
			element.focus();
		})()`
	);
}

async function focusSelectorWithoutScroll(cdp: CdpClient, selector: string): Promise<void> {
	await evaluate(
		cdp,
		`(() => {
			const element = document.querySelector(${JSON.stringify(selector)});
			if (!element) {
				throw new Error(${JSON.stringify(`Could not focus ${selector}`)});
			}
			element.focus({preventScroll: true});
		})()`
	);
}

async function clickSelector(cdp: CdpClient, selector: string): Promise<void> {
	const point = await evaluate<{x: number; y: number}>(
		cdp,
		`new Promise((resolve) => {
			const element = document.querySelector(${JSON.stringify(selector)});
			if (!element) {
				throw new Error(${JSON.stringify(`Could not click ${selector}`)});
			}
			const initialBounds = element.getBoundingClientRect();
			if (initialBounds.top < 0 || initialBounds.bottom > window.innerHeight) {
				element.scrollIntoView({block: 'center'});
			}
			requestAnimationFrame(() => {
				const bounds = element.getBoundingClientRect();
				resolve({x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2});
			});
		})`
	);
	await cdp.send("Input.dispatchMouseEvent", {
		type: "mousePressed",
		x: point.x,
		y: point.y,
		button: "left",
		clickCount: 1,
	});
	await cdp.send("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x: point.x,
		y: point.y,
		button: "left",
		clickCount: 1,
	});
	await twoAnimationFrames(cdp);
}

async function pressKey(cdp: CdpClient, requestedKey: string): Promise<void> {
	const keys: Record<string, {key: string; code: string; virtualKeyCode: number; text?: string}> =
		{
			Enter: {key: "Enter", code: "Enter", virtualKeyCode: 13, text: "\r"},
			Space: {key: " ", code: "Space", virtualKeyCode: 32, text: " "},
			ArrowUp: {key: "ArrowUp", code: "ArrowUp", virtualKeyCode: 38},
			ArrowDown: {key: "ArrowDown", code: "ArrowDown", virtualKeyCode: 40},
			ArrowRight: {key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39},
			Escape: {key: "Escape", code: "Escape", virtualKeyCode: 27},
		};
	const key = keys[requestedKey];

	if (!key) {
		throw new Error(`Unsupported benchmark key ${requestedKey}`);
	}

	await cdp.send("Input.dispatchKeyEvent", {
		type: "rawKeyDown",
		key: key.key,
		code: key.code,
		windowsVirtualKeyCode: key.virtualKeyCode,
	});

	if (key.text) {
		await cdp.send("Input.dispatchKeyEvent", {
			type: "char",
			key: key.key,
			code: key.code,
			windowsVirtualKeyCode: key.virtualKeyCode,
			text: key.text,
			unmodifiedText: key.text,
		});
	}

	await cdp.send("Input.dispatchKeyEvent", {
		type: "keyUp",
		key: key.key,
		code: key.code,
		windowsVirtualKeyCode: key.virtualKeyCode,
	});
	await twoAnimationFrames(cdp);
}

async function replaceText(cdp: CdpClient, selector: string, text: string): Promise<void> {
	await evaluate(
		cdp,
		`(() => {
			const input = document.querySelector(${JSON.stringify(selector)});
			if (!input || typeof input.select !== 'function') {
				throw new Error(${JSON.stringify(`Could not edit ${selector}`)});
			}
			input.focus();
			input.select();
		})()`
	);
	await cdp.send("Input.insertText", {text});
	await waitForExpression(
		cdp,
		`document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(text)}`,
		10000
	);
}

async function getInputValue(cdp: CdpClient): Promise<string> {
	return evaluate<string>(cdp, "document.querySelector('#input')?.value ?? ''");
}

async function waitForViewerImage(cdp: CdpClient, imageId: number): Promise<void> {
	await waitForExpression(
		cdp,
		`document.querySelector('#image-viewer img')?.src.includes('/benchmark-image/${imageId}.svg')`,
		10000
	);
}

async function viewerShowsImage(cdp: CdpClient, imageId: number): Promise<boolean> {
	return evaluate<boolean>(
		cdp,
		`document.querySelector('#image-viewer img')?.src.includes('/benchmark-image/${imageId}.svg') === true`
	);
}

async function waitForHostCondition(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
	const startedAt = Date.now();

	while (!predicate() && Date.now() - startedAt < timeoutMs) {
		await delay(10);
	}

	if (!predicate()) {
		throw new Error("Timed out waiting for the synthetic benchmark host");
	}
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
			const followingMessageId = (element) => {
				let next = element.nextElementSibling;
				while (next && !next.classList.contains("msg")) {
					next = next.nextElementSibling;
				}
				const nestedMessage = next?.querySelector('[id^="msg-"]');
				return Number(
					next?.id?.slice(4) ||
						next?.getAttribute("data-first-message-id") ||
						nestedMessage?.id.slice(4)
				);
			};
			const ids = [...document.querySelectorAll('#chat .messages [id^="msg-"]')]
				.map((element) => Number(element.id.slice(4)))
				.filter(Number.isFinite);
			const retainedCount = messages?.getAttribute("data-retained-count");
			const windowStart = messages?.getAttribute("data-window-start");
			const windowEnd = messages?.getAttribute("data-window-end");
			return {
				messageIds: ids,
				messageCount: ids.length,
				windowed: retainedCount !== null && windowStart !== null && windowEnd !== null,
				retainedCount: Number(retainedCount ?? ids.length),
				windowStart: Number(windowStart ?? 0),
				windowEnd: Number(windowEnd ?? ids.length),
				messageElementCount: document.querySelectorAll("#chat .messages .msg").length,
				descendantElementCount: messages?.querySelectorAll("*").length ?? 0,
				totalElementCount: document.querySelectorAll("*").length,
				bottomOffset: chat ? chat.scrollHeight - chat.scrollTop - chat.clientHeight : -1,
				scrollTop: chat?.scrollTop ?? -1,
				scrollHeight: chat?.scrollHeight ?? -1,
				clientHeight: chat?.clientHeight ?? -1,
				unreadMarkerCount: document.querySelectorAll("#chat .unread-marker").length,
				unreadMarkerMessageIds: [...document.querySelectorAll("#chat .unread-marker")]
					.map(followingMessageId).filter(Number.isFinite),
				dateMarkerCount: document.querySelectorAll("#chat .date-marker").length,
				dateMarkerMessageIds: [...document.querySelectorAll("#chat .date-marker-container")]
					.map(followingMessageId).filter(Number.isFinite),
				role: messages?.getAttribute("role") ?? null,
				ariaLive: messages?.getAttribute("aria-live") ?? null,
			};
		})()`
	);
}

async function getListenerSnapshot(cdp: CdpClient): Promise<ListenerSnapshot> {
	return evaluate<ListenerSnapshot>(cdp, "window.__tlBenchmark.listenerSnapshot()");
}

async function getStatusModeSnapshot(cdp: CdpClient): Promise<StatusModeSnapshot> {
	return evaluate<StatusModeSnapshot>(
		cdp,
		`(() => {
			const statusTypes = ${JSON.stringify([...condensedTypes])};
			return {
				condensedContainers: document.querySelectorAll('#chat [data-type="condensed"]').length,
				statusRows: statusTypes.reduce(
					(total, type) => total + document.querySelectorAll('#chat .msg[data-type="' + type + '"]').length,
					0
				),
			};
		})()`
	);
}

function statusModeIsCorrect(
	snapshot: StatusModeSnapshot,
	statusMessages: StatusMessageMode
): boolean {
	if (statusMessages === "condensed") {
		return snapshot.condensedContainers > 0;
	}

	if (statusMessages === "hidden") {
		return snapshot.condensedContainers === 0 && snapshot.statusRows === 0;
	}

	return snapshot.condensedContainers === 0 && snapshot.statusRows > 0;
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

async function scrollToWindowBottom(cdp: CdpClient): Promise<void> {
	await evaluate(
		cdp,
		`new Promise((resolve) => {
			const chat = document.querySelector("#chat .chat");
			chat.scrollTop = chat.scrollHeight;
			chat.dispatchEvent(new Event("scroll"));
			chat.dispatchEvent(new Event("scroll"));
			requestAnimationFrame(() => resolve());
		})`
	);
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

async function waitForHistoryIdle(cdp: CdpClient): Promise<void> {
	await waitForExpression(
		cdp,
		`(() => {
			const container = document.querySelector('[data-message-window="older"]');
			const button = document.querySelector(
				'[data-message-window="older"] button, .show-more:not(.show-newer) .btn'
			);
			return container?.getAttribute('aria-busy') !== 'true' && (!button || !button.disabled);
		})()`,
		30000
	);
	await twoAnimationFrames(cdp);
}

async function olderButtonLoadsHistory(cdp: CdpClient): Promise<boolean> {
	return evaluate(
		cdp,
		`(() => {
			const container = document.querySelector('[data-message-window="older"]');
			const button = container?.querySelector("button") ?? document.querySelector(
				'.show-more:not(.show-newer) .btn'
			);
			return !container || button?.textContent?.includes("Load older messages") === true;
		})()`
	);
}

async function loadOneHistoryPage(
	host: BenchmarkHost,
	cdp: CdpClient
): Promise<{loadedCount: number; anchorError: number}> {
	const initialPages = host.historyPageCount;

	for (let transition = 0; transition < 100; transition++) {
		await scrollToTop(cdp);
		const loadsHistory = await olderButtonLoadsHistory(cdp);
		const anchor = loadsHistory ? await getFirstVisibleAnchor(cdp) : null;
		const before = await getDomSnapshot(cdp);
		const changed = await clickWindowButton(cdp, "older");

		if (!changed) {
			throw new Error("Could not reach the next durable history page");
		}

		await waitForHistoryIdle(cdp);

		if (!loadsHistory) {
			continue;
		}

		const startedAt = Date.now();

		while (host.historyPageCount === initialPages && Date.now() - startedAt < 30000) {
			await delay(10);
		}

		if (host.historyPageCount === initialPages) {
			throw new Error("The durable history request did not reach the benchmark server");
		}

		const after = await getDomSnapshot(cdp);
		return {
			loadedCount: after.retainedCount - before.retainedCount,
			anchorError: await getAnchorError(cdp, anchor),
		};
	}

	throw new Error("Loaded history window required too many transitions");
}

async function getFirstVisibleAnchor(cdp: CdpClient): Promise<{id: number; offset: number} | null> {
	return getVisibleAnchor(cdp, "first");
}

async function getLastVisibleAnchor(cdp: CdpClient): Promise<{id: number; offset: number} | null> {
	return getVisibleAnchor(cdp, "last");
}

async function getVisibleAnchor(
	cdp: CdpClient,
	edge: "first" | "last"
): Promise<{id: number; offset: number} | null> {
	return evaluate(
		cdp,
		`(() => {
			const chat = document.querySelector("#chat .chat");
			const chatBounds = chat.getBoundingClientRect();
			const messages = [...document.querySelectorAll('#chat .messages [id^="msg-"]')]
				.filter((element) => {
					const bounds = element.getBoundingClientRect();
					return bounds.height > 0 && bounds.bottom > chatBounds.top && bounds.top < chatBounds.bottom;
				});
			const identified = ${edge === "first" ? "messages[0]" : "messages.at(-1)"};
			return identified ? {
				id: Number(identified.id.slice(4)),
				offset: identified.getBoundingClientRect().top - chatBounds.top,
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

async function getAnchorError(
	cdp: CdpClient,
	anchor: {id: number; offset: number} | null
): Promise<number> {
	if (!anchor) {
		return 0;
	}

	const current = await getMessageOffset(cdp, anchor.id);
	return current === null ? Number.POSITIVE_INFINITY : Math.abs(current - anchor.offset);
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
		`(() => {
			const messages = document.querySelector('#chan-${channelId} .messages');
			const messageReady = messages?.getAttribute('data-retained-last-id') === '${expectedMessageId}' ||
				Boolean(messages?.querySelector('#msg-${expectedMessageId}'));
			return location.hash.startsWith('#/chan-${channelId}') && messageReady;
		})()`,
		60000
	);
	await twoAnimationFrames(cdp);
}

async function navigateChannelHistory(
	cdp: CdpClient,
	direction: "back" | "forward",
	channelId: number,
	expectedMessageId: number
): Promise<void> {
	await evaluate(cdp, `history.${direction}()`);
	await waitForFunction(
		cdp,
		`function(channelId, expectedMessageId) {
			const messages = document.querySelector('#chan-' + channelId + ' .messages');
			const messageReady = messages?.getAttribute('data-retained-last-id') === String(expectedMessageId) ||
				Boolean(messages?.querySelector('#msg-' + expectedMessageId));
			return location.hash.startsWith('#/chan-' + channelId) && messageReady;
		}`,
		[channelId, expectedMessageId],
		60000
	);
	await twoAnimationFrames(cdp);
}

async function waitForMessage(cdp: CdpClient, id: number, timeoutMs: number): Promise<void> {
	await waitForExpression(cdp, `document.querySelector('#msg-${id}')`, timeoutMs);
}

async function waitForRetainedCount(
	cdp: CdpClient,
	count: number,
	timeoutMs: number
): Promise<void> {
	await waitForFunction(
		cdp,
		`function(count) {
			const messages = document.querySelector('#chat .messages');
			const retained = messages?.getAttribute('data-retained-count');
			return retained === String(count) ||
				(retained === null && messages?.querySelectorAll('[id^="msg-"]').length === count);
		}`,
		[count],
		timeoutMs
	);
}

async function waitForRetainedLastId(
	cdp: CdpClient,
	messageId: number,
	timeoutMs: number
): Promise<void> {
	await waitForFunction(
		cdp,
		`function(messageId) {
			const messages = document.querySelector('#chat .messages');
			return messages?.getAttribute('data-retained-last-id') === String(messageId) ||
				Boolean(messages?.querySelector('#msg-' + messageId));
		}`,
		[messageId],
		timeoutMs
	);
}

async function collectSettledHeap(cdp: CdpClient): Promise<number> {
	await twoAnimationFrames(cdp);
	const readings = [await collectHeap(cdp), await collectHeap(cdp), await collectHeap(cdp)];
	return Math.min(...readings);
}

async function collectReachableMessages(
	cdp: CdpClient,
	expected: number[],
	maxTransitions = 50
): Promise<Reachability> {
	let localOrderValid = true;
	const localDuplicates = new Set<number>();
	const reachable = new Set<number>();
	const visitedWindowStarts = new Set<number>();
	const observedUnreadMarkerIds = new Set<number>();
	const observedDateMarkerIds = new Set<number>();
	let maxUnreadMarkerCount = 0;
	let maxDateMarkerCount = 0;
	let dateMarkerLayoutValid = true;
	let windowTransitions = 0;

	const collect = async () => {
		await expandCondensedMessages(cdp);
		const snapshot = await getDomSnapshot(cdp);
		const ids = snapshot.messageIds;
		visitedWindowStarts.add(snapshot.windowStart);
		maxUnreadMarkerCount = Math.max(maxUnreadMarkerCount, snapshot.unreadMarkerCount);
		maxDateMarkerCount = Math.max(maxDateMarkerCount, snapshot.dateMarkerCount);
		dateMarkerLayoutValid &&=
			snapshot.dateMarkerCount === snapshot.dateMarkerMessageIds.length &&
			duplicates(snapshot.dateMarkerMessageIds).length === 0;
		snapshot.unreadMarkerMessageIds.forEach((id) => observedUnreadMarkerIds.add(id));
		snapshot.dateMarkerMessageIds.forEach((id) => observedDateMarkerIds.add(id));
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
		await scrollToTop(cdp);

		if (await olderButtonLoadsHistory(cdp)) {
			break;
		}

		const changed = await clickWindowButton(cdp, "older");

		if (!changed) {
			break;
		}

		windowTransitions++;
		await collect();
	}

	await collect();

	for (let transition = 0; transition < maxTransitions; transition++) {
		await scrollToWindowBottom(cdp);
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
			localDuplicates.size === 0 &&
			dateMarkerLayoutValid,
		reachableCount: reachable.size,
		expectedCount: expected.length,
		missing: missing.slice(0, 20),
		unexpected: unexpected.slice(0, 20),
		localOrderValid,
		localDuplicates: [...localDuplicates].slice(0, 20),
		windowTransitions,
		visitedWindowStarts: [...visitedWindowStarts],
		maxUnreadMarkerCount,
		observedUnreadMarkerIds: [...observedUnreadMarkerIds],
		maxDateMarkerCount,
		observedDateMarkerIds: [...observedDateMarkerIds],
		dateMarkerLayoutValid,
	};
}

async function expandCondensedMessages(cdp: CdpClient): Promise<void> {
	await evaluate(
		cdp,
		`(async () => {
			for (const button of document.querySelectorAll(
				'#chat .msg.closed[data-type="condensed"] .toggle-button'
			)) {
				button.click();
			}
			await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		})()`
	);
}

async function clickWindowButton(cdp: CdpClient, direction: "older" | "newer"): Promise<boolean> {
	const before = await evaluate<string | null>(
		cdp,
		`(() => {
			const button = document.querySelector('[data-message-window="${direction}"] button') ??
				${direction === "older" ? "document.querySelector('.show-more:not(.show-newer) .btn')" : "null"};
			if (!button || button.disabled || button.offsetParent === null) {
				return null;
			}
			const messages = document.querySelector("#chat .messages");
			const ids = [...document.querySelectorAll('#chat .messages [id^="msg-"]')];
			const signature = [
				ids[0]?.id,
				ids.at(-1)?.id,
				ids.length,
				messages?.getAttribute("data-retained-count"),
				messages?.getAttribute("data-window-start"),
				messages?.getAttribute("data-window-end"),
			].join(":");
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
			const messages = document.querySelector("#chat .messages");
			const ids = [...document.querySelectorAll('#chat .messages [id^="msg-"]')];
			return [
				ids[0]?.id,
				ids.at(-1)?.id,
				ids.length,
				messages?.getAttribute("data-retained-count"),
				messages?.getAttribute("data-window-start"),
				messages?.getAttribute("data-window-end"),
			].join(":") !== ${JSON.stringify(before)};
		})()`,
		30000
	);
	await waitForExpression(
		cdp,
		`(() => {
			const button = document.querySelector('[data-message-window="${direction}"] button') ??
				${direction === "older" ? "document.querySelector('.show-more:not(.show-newer) .btn')" : "null"};
			return !button || !button.disabled;
		})()`,
		30000
	);
	await twoAnimationFrames(cdp);
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

function makeInteractionMessages(): SharedMsg[] {
	const messages = makeMessages(1, 600);

	const byId = (id: number) => {
		const message = messages[id - 1];

		if (!message || message.id !== id) {
			throw new Error(`Interaction fixture message ${id} is unavailable`);
		}

		return message;
	};

	const parent = byId(110);
	parent.text = "Off-window reply parent";
	const reply = byId(596);
	reply.replyTo = parent.msgid;
	reply.replyToNick = parent.from?.nick;
	reply.replyToText = parent.text;
	reply.text = "Reply with an off-window parent";

	const longPreview = byId(587);
	longPreview.text = "Deterministic long link preview";
	longPreview.previews = [
		{
			type: "link",
			head: "Deterministic preview",
			body: "Long preview body ".repeat(80),
			thumb: "",
			size: 0,
			link: "https://benchmark.invalid/long-preview",
			shown: true,
		},
	];

	for (const id of [110, 350, 590]) {
		const message = byId(id);
		message.previews = [
			{
				type: "image",
				head: `Benchmark image ${id}`,
				body: "",
				thumb: `/benchmark-image/${id}.svg`,
				size: 0,
				link: `/benchmark-image/${id}.svg`,
				shown: true,
			},
		];
	}

	return messages;
}

function makeScenario(
	history: SharedMsg[],
	initialMessages: SharedMsg[],
	pageSize: number,
	statusMessages: StatusMessageMode
): Scenario {
	const secondaryMessage = makeMessage(900000);
	secondaryMessage.time = new Date(history.at(-1)!.time.getTime());

	return {
		fixture: {
			history: [...history],
			initialMessages: [...initialMessages],
			totalMessages: history.length,
		},
		secondaryMessage,
		pageSize,
		statusMessages,
	};
}

function expectedVisibleIds(
	messages: readonly SharedMsg[],
	statusMessages: StatusMessageMode
): number[] {
	return messages
		.filter((message) => statusMessages !== "hidden" || !condensedTypes.has(message.type || ""))
		.map((message) => message.id);
}

function expectedDateMarkerIds(
	messages: readonly SharedMsg[],
	statusMessages: StatusMessageMode
): number[] {
	const visible = messages.filter(
		(message) => statusMessages !== "hidden" || !condensedTypes.has(message.type || "")
	);
	const markerIds: number[] = [];
	let previousDate: Date | undefined;

	for (const message of visible) {
		const currentDate = new Date(message.time);

		if (
			!previousDate ||
			previousDate.getUTCDate() !== currentDate.getUTCDate() ||
			previousDate.getUTCMonth() !== currentDate.getUTCMonth() ||
			previousDate.getUTCFullYear() !== currentDate.getUTCFullYear()
		) {
			markerIds.push(message.id);
		}

		previousDate = currentDate;
	}

	return markerIds;
}

function expectedRange(first: number, end: number, statusMessages: StatusMessageMode): number[] {
	return expectedVisibleIds(makeMessages(first, end - first), statusMessages);
}

function expectedUnreadMarkerId(
	history: readonly SharedMsg[],
	initialMessages: readonly SharedMsg[],
	statusMessages: StatusMessageMode
): number | undefined {
	const firstUnread = initialMessages.at(-50)?.id ?? 0;
	return expectedVisibleIds(
		history.filter((message) => message.id > firstUnread),
		statusMessages
	)[0];
}

function markerObservedExactlyOnce(observed: number[], expected: number | undefined): boolean {
	return expected === undefined
		? observed.length === 0
		: observed.length === 1 && observed[0] === expected;
}

function markerSetsEqual(observed: number[], expected: number[]): boolean {
	const observedSet = new Set(observed);
	return observedSet.size === expected.length && expected.every((id) => observedSet.has(id));
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
		allowValidationFailures: false,
		runs: 3,
		chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		cpuRate: 1,
		inspect: false,
		port: 4173,
		statusMessages: "condensed",
	};

	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];

		if (argument === "--runs") {
			result.runs = Number(argv[++index]);
		} else if (argument === "--allow-validation-failures") {
			result.allowValidationFailures = true;
		} else if (argument === "--chrome") {
			result.chromePath = argv[++index];
		} else if (argument === "--cpu-rate") {
			result.cpuRate = Number(argv[++index]);
		} else if (argument === "--inspect") {
			result.inspect = true;
		} else if (argument === "--port") {
			result.port = Number(argv[++index]);
		} else if (argument === "--output") {
			result.outputPath = argv[++index];
		} else if (argument === "--scenario") {
			const scenario = argv[++index] as ScenarioName;

			if (!["control", "large-history", "long-session", "interactions"].includes(scenario)) {
				throw new Error(`Unknown benchmark scenario ${scenario}`);
			}

			result.scenario = scenario;
		} else if (argument === "--status-messages") {
			const statusMessages = argv[++index] as StatusMessageMode;

			if (!["condensed", "hidden", "shown"].includes(statusMessages)) {
				throw new Error(`Unknown status-message mode ${statusMessages}`);
			}

			result.statusMessages = statusMessages;
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

	if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535) {
		throw new Error("--port must be an integer from 1 through 65535");
	}

	return result;
}

function summarize(runs: BrowserRun[]): Record<string, any> {
	const control = runs.filter((run) => run.scenario === "control");
	const large = runs.filter((run) => run.scenario === "large-history");
	const long = runs.filter((run) => run.scenario === "long-session");
	const summary: Record<string, any> = {};

	if (control.length > 0) {
		summary.control = {
			completedRuns: control.length,
			interactiveMs: median(control.map((run) => run.phases.initial.durationMs)),
			domNodes: median(control.map((run) => run.dom.initial.descendantElementCount)),
			heapMiB: bytesToMiB(median(control.map((run) => run.heapBytes.initial))),
		};
	}

	if (large.length > 0) {
		summary.largeHistory = {
			completedRuns: large.length,
			loadTo10000Ms: median(large.map((run) => run.phases.loadHistory.durationMs)),
			inputDelayP95Ms: median(large.map((run) => run.input.loadHistory.timerDelay.p95)),
			totalBlockingTimeMs: median(
				large.map((run) => run.phases.loadHistory.totalBlockingTimeMs)
			),
			domNodes: median(large.map((run) => run.dom.at10000.descendantElementCount)),
			renderedMessages: median(large.map((run) => run.dom.at10000.messageCount)),
			heapMiB: bytesToMiB(median(large.map((run) => run.heapBytes.at10000))),
			listenerCount: median(large.map((run) => sumListenerSnapshot(run.listeners.at10000))),
		};
	}

	if (long.length > 0) {
		const runMaxRenderedMessages = long.map((run) =>
			Math.max(...Object.values(run.dom).map((value) => value.messageCount))
		);
		const runMaxDomNodes = long.map((run) =>
			Math.max(...Object.values(run.dom).map((value) => value.descendantElementCount))
		);
		const runMaxHeapBytes = long.map((run) => Math.max(...Object.values(run.heapBytes)));
		const runMaxListenerCounts = long.map((run) =>
			Math.max(...Object.values(run.listeners).map(sumListenerSnapshot))
		);
		summary.longSession = {
			completedRuns: long.length,
			bottomBurstMs: median(long.map((run) => run.phases.bottomBurst.durationMs)),
			scrolledBurstMs: median(long.map((run) => run.phases.scrolledBurst.durationMs)),
			inputDelayP95Ms: median(
				long.map((run) =>
					Math.max(
						run.input.bottomBurst.timerDelay.p95,
						run.input.scrolledBurst.timerDelay.p95
					)
				)
			),
			bottomInputDelayP95Ms: median(long.map((run) => run.input.bottomBurst.timerDelay.p95)),
			scrolledInputDelayP95Ms: median(
				long.map((run) => run.input.scrolledBurst.timerDelay.p95)
			),
			historyPrependMs: median(long.map((run) => run.phases.historyPrepends.durationMs)),
			channelRoundTripMs: median(long.map((run) => run.phases.channelRoundTrip.durationMs)),
			medianOfRunMaxRenderedMessages: median(runMaxRenderedMessages),
			acrossRunMaxRenderedMessages: Math.max(...runMaxRenderedMessages),
			medianOfRunMaxDomNodes: median(runMaxDomNodes),
			acrossRunMaxDomNodes: Math.max(...runMaxDomNodes),
			medianOfRunMaxHeapMiB: bytesToMiB(median(runMaxHeapBytes)),
			acrossRunMaxHeapMiB: bytesToMiB(Math.max(...runMaxHeapBytes)),
			medianOfRunMaxListenerCount: median(runMaxListenerCounts),
			acrossRunMaxListenerCount: Math.max(...runMaxListenerCounts),
			stabilityHeapDeltaMiB: bytesToMiB(
				median(long.map((run) => run.correctness.stabilityHeapDeltaBytes ?? 0))
			),
		};
	}

	return summary;
}

function sumListenerSnapshot(snapshot: ListenerSnapshot): number {
	return snapshot.windowResize + snapshot.documentTouch + snapshot.messageTouch;
}

function listenerSnapshotsEqual(left: ListenerSnapshot, right: ListenerSnapshot): boolean {
	return (
		left.windowResize === right.windowResize &&
		left.documentTouch === right.documentTouch &&
		left.messageTouch === right.messageTouch
	);
}

function linearSlope(values: number[]): number {
	const center = (values.length - 1) / 2;
	let numerator = 0;
	let denominator = 0;

	values.forEach((value, index) => {
		const offset = index - center;
		numerator += offset * value;
		denominator += offset * offset;
	});

	return denominator === 0 ? 0 : numerator / denominator;
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

function hashWorkingTreePaths(paths: string[]): string {
	const hash = createHash("sha256");
	const files = execFileSync(
		"git",
		["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...paths],
		{
			cwd: repositoryRoot,
			encoding: "utf8",
		}
	)
		.split("\0")
		.filter(Boolean)
		.sort();

	for (const file of files) {
		const absolutePath = path.join(repositoryRoot, file);
		hash.update(file);
		hash.update("\0");
		hash.update(existsSync(absolutePath) ? readFileSync(absolutePath) : "<deleted>");
		hash.update("\0");
	}

	return hash.digest("hex");
}

function getBenchmarkIdentity(): BenchmarkIdentity {
	return {
		productFingerprint: hashWorkingTreePaths([
			"client",
			"shared",
			"package.json",
			"yarn.lock",
			"vite.config.ts",
			"tsconfig.json",
		]),
		harnessFingerprint: hashWorkingTreePaths(["test/benchmark"]),
	};
}

function hashDirectory(directory: string): string {
	const hash = createHash("sha256");

	const visit = (current: string) => {
		for (const entry of readdirSync(current).sort()) {
			const absolutePath = path.join(current, entry);
			const relativePath = path.relative(directory, absolutePath);
			const stats = statSync(absolutePath);

			if (stats.isDirectory()) {
				visit(absolutePath);
			} else if (stats.isFile()) {
				hash.update(relativePath);
				hash.update(readFileSync(absolutePath));
			}
		}
	};

	visit(directory);
	return hash.digest("hex");
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

function waitForTerminationSignal(): Promise<void> {
	return new Promise((resolve) => {
		const finish = () => {
			process.removeListener("SIGINT", finish);
			process.removeListener("SIGTERM", finish);
			resolve();
		};

		process.once("SIGINT", finish);
		process.once("SIGTERM", finish);
	});
}

async function main(): Promise<void> {
	const args = parseArguments(process.argv.slice(2));
	const identity = getBenchmarkIdentity();
	buildClient();

	if (getBenchmarkIdentity().productFingerprint !== identity.productFingerprint) {
		throw new Error("Client source changed while producing the benchmark build");
	}

	const host = new BenchmarkHost();

	if (args.inspect) {
		const messages = makeInteractionMessages();

		host.prepare(makeScenario(messages, messages, 100, args.statusMessages));
		const pageUrl = await host.start(args.port);

		try {
			console.log(`Production interaction fixture: ${pageUrl}`);
			console.log(`Focused route: ${pageUrl}#/chan-2?focused=100`);
			await waitForTerminationSignal();
		} finally {
			await host.close();
		}

		return;
	}

	const pageUrl = await host.start();
	const runs: BrowserRun[] = [];

	try {
		for (let run = 1; run <= args.runs; run++) {
			if (!args.scenario || args.scenario === "control") {
				console.error(`[run ${run}] control: start`);
				const result = await runControl(host, pageUrl, args, run);
				recordBrowserRun(args, runs, result, identity);
				console.error(`[run ${run}] control: complete`);
			}

			if (!args.scenario || args.scenario === "large-history") {
				console.error(`[run ${run}] large-history: start`);
				const result = await runLargeHistory(host, pageUrl, args, run);
				recordBrowserRun(args, runs, result, identity);
				console.error(`[run ${run}] large-history: complete`);
			}

			if (!args.scenario || args.scenario === "long-session") {
				console.error(`[run ${run}] long-session: start`);
				const result = await runLongSession(host, pageUrl, args, run);
				recordBrowserRun(args, runs, result, identity);
				console.error(`[run ${run}] long-session: complete`);
			}

			if (args.scenario === "interactions") {
				console.error(`[run ${run}] interactions: start`);
				const result = await runInteractions(host, pageUrl, args, run);
				recordBrowserRun(args, runs, result, identity);
				console.error(`[run ${run}] interactions: complete`);
			}
		}
	} finally {
		await host.close();
	}

	const json = writeCheckpoint(args, runs, identity);
	console.log(json);
}

function recordBrowserRun(
	args: Arguments,
	runs: BrowserRun[],
	result: BrowserRun,
	identity: BenchmarkIdentity
): void {
	const failures = validateBrowserRun(result);
	result.validation = {passed: failures.length === 0, failures};
	runs.push(result);
	writeCheckpoint(args, runs, identity);

	if (failures.length > 0 && !args.allowValidationFailures) {
		throw new Error(`${result.scenario} run ${result.run} failed:\n- ${failures.join("\n- ")}`);
	}

	if (failures.length > 0) {
		console.error(
			`[run ${result.run}] ${
				result.scenario
			}: recorded baseline validation failures:\n- ${failures.join("\n- ")}`
		);
	}
}

function validateBrowserRun(run: BrowserRun): string[] {
	const failures: string[] = [];

	const requireBoolean = (name: string) => {
		if (run.correctness[name] !== true) {
			failures.push(`${name} was not true`);
		}
	};

	const requireReachability = (name: string) => {
		const value = run.correctness[name] as Reachability | undefined;

		if (!value?.passed) {
			failures.push(`${name} did not preserve exact reachability`);
		}
	};

	const requireComparison = (name: string) => {
		const value = run.correctness[name] as IdComparison | undefined;

		if (!value?.passed) {
			failures.push(`${name} did not preserve exact IDs and order`);
		}
	};

	if (run.consoleErrors.length > 0) {
		failures.push(`console errors: ${run.consoleErrors.join(" | ")}`);
	}

	if (run.externalRequests.length > 0) {
		failures.push(`external requests: ${run.externalRequests.join(" | ")}`);
	}

	for (const [name, snapshot] of Object.entries(run.dom)) {
		if (snapshot.windowed) {
			const bounds = [snapshot.windowStart, snapshot.windowEnd, snapshot.retainedCount];

			if (
				bounds.some((value) => !Number.isInteger(value)) ||
				snapshot.windowStart < 0 ||
				snapshot.windowStart > snapshot.windowEnd ||
				snapshot.windowEnd > snapshot.retainedCount
			) {
				failures.push(`${name} reported invalid message-window bounds`);
			}

			if (snapshot.windowEnd - snapshot.windowStart > 250) {
				failures.push(`${name} rendered more than the 250-message window`);
			}

			if (snapshot.messageCount > snapshot.windowEnd - snapshot.windowStart) {
				failures.push(`${name} rendered more message IDs than its source window`);
			}
		}

		if (snapshot.unreadMarkerCount > 1) {
			failures.push(`${name} rendered duplicate unread markers`);
		}

		if (
			snapshot.dateMarkerCount !== snapshot.dateMarkerMessageIds.length ||
			duplicates(snapshot.dateMarkerMessageIds).length > 0
		) {
			failures.push(`${name} rendered invalid date markers`);
		}
	}

	if (run.scenario === "control") {
		requireReachability("reachability");
		requireBoolean("bottomAnchored");
		requireBoolean("accessibility");
		requireBoolean("unreadMarkers");
		requireBoolean("dateMarkers");
		requireBoolean("statusMode");
		requireBoolean("statusModeAfterTraversal");

		if (run.dom.initial.retainedCount !== 100) {
			failures.push("control did not retain exactly 100 messages");
		}
	} else if (run.scenario === "large-history") {
		requireReachability("reachability");
		requireBoolean("ordered");
		requireBoolean("accessibility");
		requireBoolean("unreadMarkers");
		requireBoolean("dateMarkers");
		requireBoolean("statusMode");
		requireBoolean("statusModeAfterTraversal");

		if ((run.correctness.duplicateIds as number[])?.length !== 0) {
			failures.push("large history rendered duplicate IDs");
		}

		if (Number(run.correctness.maxPrependAnchorErrorPx) > 1) {
			failures.push("large history prepend anchor drifted by more than 1px");
		}

		if (run.dom.at10000.retainedCount !== 10000) {
			failures.push("large history did not retain exactly 10,000 messages");
		}

		if (run.input.loadHistory.timerDelay.count === 0) {
			failures.push("large history collected no input-response samples");
		}
	} else if (run.scenario === "long-session") {
		for (const name of [
			"bottomRetention",
			"scrolledMessagesReachable",
			"loadedHistory",
			"switchTrim",
			"reconnectMerge",
		]) {
			requireReachability(name);
		}

		requireComparison("scrolledWindowPreserved");

		for (const name of [
			"bottomAnchored",
			"scrolledOrder",
			"loadedHistoryMarkers",
			"statusMode",
			"statusModeAfterBottomBurst",
			"statusModeAfterScrolledBurst",
			"statusModeAfterHistory",
			"statusModeAfterSwitch",
			"statusModeAfterReconnect",
			"statusModeDuringStability",
			"stabilityDomStable",
			"stabilityHeapPlateau",
			"stabilityListenersStable",
		]) {
			requireBoolean(name);
		}

		if (run.correctness.monotonicHeapGrowth === true) {
			failures.push("forced-GC heap grew monotonically across stability cycles");
		}

		if (Number(run.correctness.scrolledAnchorErrorPx) > 1) {
			failures.push("scrolled-up anchor drifted by more than 1px");
		}

		if (Number(run.correctness.maxPrependAnchorErrorPx) > 1) {
			failures.push("history prepend anchor drifted by more than 1px");
		}

		if (Number(run.correctness.scrollEventsNeeded) < 1) {
			failures.push("the real scroll event did not move away from the bottom");
		}

		if (
			run.dom.afterBottomBurst.retainedCount !== 1500 ||
			run.dom.afterScrolledBurst.retainedCount !== 3099 ||
			run.dom.afterPrepends.retainedCount !== 5099 ||
			run.dom.afterSwitch.retainedCount !== 100 ||
			run.dom.afterReconnect.retainedCount !== 164
		) {
			failures.push("long-session retention boundaries were not exact");
		}

		if (
			run.input.bottomBurst.timerDelay.count === 0 ||
			run.input.scrolledBurst.timerDelay.count === 0
		) {
			failures.push("long session collected no input-response samples");
		}
	} else {
		for (const name of [
			"statusMode",
			"accessibility",
			"focusedMessage",
			"focusRemovalReturnsTail",
			"windowControlNavigation",
			"keyboardWindowControls",
			"noopReconnectPreservesWindow",
			"condensedControl",
			"replyParentNavigation",
			"replyComposer",
			"linkPreviewAnchoring",
			"imageNavigation",
			"inputHistoryAndDrafts",
			"search",
			"showInActive",
			"finalState",
		]) {
			requireBoolean(name);
		}
	}

	return failures;
}

function writeCheckpoint(args: Arguments, runs: BrowserRun[], identity: BenchmarkIdentity): string {
	const output = {
		metadata: {
			benchmarkSchema: 2,
			allowValidationFailures: args.allowValidationFailures,
			revision: execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: repositoryRoot,
				encoding: "utf8",
			}).trim(),
			workingTreeDirty:
				execFileSync("git", ["status", "--porcelain"], {
					cwd: repositoryRoot,
					encoding: "utf8",
				}).trim().length > 0,
			productFingerprint: identity.productFingerprint,
			harnessFingerprint: identity.harnessFingerprint,
			bundleFingerprint: hashDirectory(publicDirectory),
			buildMode: "production-build-this-run",
			chrome: execFileSync(args.chromePath, ["--version"], {encoding: "utf8"}).trim(),
			node: process.version,
			runs: args.runs,
			cpuRate: args.cpuRate,
			statusMessages: args.statusMessages,
			viewport: "1440x900@1x",
			timezone: "UTC",
			fixture: "deterministic synthetic messages; no production data",
			completedRuns: Object.fromEntries(
				["control", "large-history", "long-session", "interactions"].map((scenario) => [
					scenario,
					runs.filter((run) => run.scenario === scenario).length,
				])
			),
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

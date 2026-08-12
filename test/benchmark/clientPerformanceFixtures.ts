import {ChanState, ChanType} from "../../shared/types/chan";
import {MessageType, SharedMsg} from "../../shared/types/msg";
import {SharedNetwork} from "../../shared/types/network";

const baseTime = Date.UTC(2026, 0, 1, 12, 0, 0);

export type BenchmarkChannelFixture = {
	history: SharedMsg[];
	initialMessages: SharedMsg[];
	totalMessages: number;
};

export function makeMessages(firstId: number, count: number): SharedMsg[] {
	return Array.from({length: count}, (_, index) => makeMessage(firstId + index));
}

export function makeMessage(id: number): SharedMsg {
	const cycle = Math.abs(id) % 20;
	const nick = `user-${Math.abs(id) % 37}`;
	const from = {nick, mode: ""};
	const message: SharedMsg = {
		from,
		hostmask: `${nick}!benchmark@invalid`,
		id,
		msgid: `bench-${id}`,
		text: `Synthetic message ${id} with #benchmark, user-1, emoji ✅, and \u0002style\u000f`,
		type: MessageType.MESSAGE,
		time: new Date(baseTime + id * 1000),
		users: [],
	};

	if (cycle <= 3) {
		message.type = [MessageType.JOIN, MessageType.PART, MessageType.QUIT, MessageType.NICK][
			cycle
		];

		if (message.type === MessageType.NICK) {
			message.new_nick = `${nick}-renamed`;
		}
	} else if (cycle === 4) {
		message.type = MessageType.ACTION;
		message.text = `waves at user-${Math.abs(id - 1) % 37}`;
	} else if (cycle === 5) {
		message.type = MessageType.NOTICE;
		message.text = `Synthetic notice ${id}`;
	}

	if (cycle === 6 && id > 5) {
		message.replyTo = `bench-${id - 5}`;
		message.replyToNick = `user-${Math.abs(id - 5) % 37}`;
		message.replyToText = `Synthetic message ${id - 5}`;
	}

	if (cycle === 7) {
		const link = `https://benchmark.invalid/message/${id}`;
		message.text = `Synthetic link preview ${link}`;
		message.previews = [
			{
				type: "link",
				head: `Preview ${id}`,
				body: "Deterministic preview body with no external request",
				thumb: "",
				size: 0,
				link,
				shown: false,
			},
		];
	}

	if (cycle === 8) {
		message.text = `first line ${id}\nsecond line with channel #benchmark`;
		message.multiline = true;
	}

	return message;
}

export function makeNetwork(
	channelFixture: BenchmarkChannelFixture,
	secondaryMessage: SharedMsg,
	channelMessages = channelFixture.initialMessages
): SharedNetwork {
	return {
		uuid: "benchmark-network",
		name: "Benchmark Network",
		nick: "benchmark-user",
		serverOptions: {
			CHANTYPES: ["#"],
			PREFIX: {
				prefix: [
					{symbol: "@", mode: "o"},
					{symbol: "+", mode: "v"},
				],
				modeToSymbol: {o: "@", v: "+"},
				symbols: ["@", "+"],
			},
			NETWORK: "Benchmark Network",
			supportsReply: true,
			MONITOR: null,
		},
		status: {connected: true, secure: true},
		channels: [
			{
				id: 1,
				messages: [],
				totalMessages: 0,
				name: "Benchmark Network",
				key: "",
				topic: "",
				firstUnread: 0,
				unread: 0,
				highlight: 0,
				muted: false,
				type: ChanType.LOBBY,
				state: ChanState.JOINED,
			},
			{
				id: 2,
				messages: channelMessages,
				totalMessages: channelFixture.totalMessages,
				name: "#benchmark",
				key: "",
				topic: "Synthetic performance benchmark",
				firstUnread: channelMessages.at(-50)?.id ?? 0,
				unread: 0,
				highlight: 0,
				muted: false,
				type: ChanType.CHANNEL,
				state: ChanState.JOINED,
			},
			{
				id: 3,
				messages: [secondaryMessage],
				totalMessages: 1,
				name: "#secondary",
				key: "",
				topic: "Synthetic secondary channel",
				firstUnread: secondaryMessage.id,
				unread: 0,
				highlight: 0,
				muted: false,
				type: ChanType.CHANNEL,
				state: ChanState.JOINED,
			},
		],
	};
}

export function expectedIds(messages: SharedMsg[]): number[] {
	return messages.map((message) => message.id);
}

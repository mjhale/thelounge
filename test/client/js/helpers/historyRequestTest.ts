import {ChanState, ChanType} from "../../../../shared/types/chan";
import {MessageType} from "../../../../shared/types/msg";
import type {ClientChan} from "../../../../client/js/types";
import {beginHistoryRequest} from "../../../../client/js/helpers/historyRequest";

function makeChannel(): ClientChan {
	return {
		id: 42,
		name: "#history",
		type: ChanType.CHANNEL,
		state: ChanState.JOINED,
		key: "",
		topic: "",
		firstUnread: 0,
		unread: 0,
		highlight: 0,
		muted: false,
		moreHistoryAvailable: true,
		editTopic: false,
		pendingMessage: "",
		inputHistoryPosition: 0,
		inputHistory: [""],
		historyLoading: false,
		scrolledToBottom: false,
		usersOutdated: false,
		typingNicks: [],
		replyingTo: null,
		users: [],
		messages: [
			{
				id: 4,
				time: new Date(4000),
				type: MessageType.NOTICE,
				text: "Shown in active",
				showInActive: true,
				users: [],
			},
			{
				id: 5,
				time: new Date(5000),
				type: MessageType.MESSAGE,
				text: "First channel message",
				users: [],
			},
		],
	};
}

describe("beginHistoryRequest", () => {
	it("atomically rejects duplicate requests for the same cursor", () => {
		const channel = makeChannel();

		expect(beginHistoryRequest(channel, true, true)).toEqual({
			target: 42,
			lastId: 5,
			condensed: true,
		});
		expect(channel.historyLoading).toBe(true);
		expect(beginHistoryRequest(channel, true, true)).toBeUndefined();
	});

	it("does not begin unavailable or disconnected requests", () => {
		const disconnected = makeChannel();
		expect(beginHistoryRequest(disconnected, false, false)).toBeUndefined();
		expect(disconnected.historyLoading).toBe(false);

		const exhausted = makeChannel();
		exhausted.moreHistoryAvailable = false;
		expect(beginHistoryRequest(exhausted, true, false)).toBeUndefined();
		expect(exhausted.historyLoading).toBe(false);
	});
});

import {MessageType} from "../../../../shared/types/msg";
import type {ClientMessage} from "../../../../client/js/types";
import {
	addMessageId,
	createMessageIdIndex,
	getFirstMessageIndexAfterId,
	getMessageIndexById,
	getMessageCollectionSignature,
	getMessageWindow,
	getTailWindowStart,
	getWindowStartForIndex,
	messageWindowSize,
	moveMessageWindow,
	removeMessageIds,
	reconcileMessageWindow,
} from "../../../../client/js/helpers/messageWindow";

function makeMessages(firstId: number, count: number): ClientMessage[] {
	return Array.from({length: count}, (_, index) => {
		const id = firstId + index;
		return {
			id,
			msgid: `msg-${id}`,
			time: new Date(id * 1000),
			type: MessageType.MESSAGE,
			text: `Message ${id}`,
			from: {nick: "benchmark", mode: ""},
			users: [],
		};
	});
}

describe("message window", () => {
	it("keeps small channels entirely rendered", () => {
		expect(getMessageWindow(100, 50)).toEqual({
			start: 0,
			end: 100,
			hasOlder: false,
			hasNewer: false,
		});
	});

	it("bounds the tail and makes every retained message reachable", () => {
		const length = 10000;
		let start = getTailWindowStart(length);
		const reachable = new Set<number>();
		let hasOlder: boolean;

		do {
			const window = getMessageWindow(length, start);
			hasOlder = window.hasOlder;

			for (let index = window.start; index < window.end; index++) {
				reachable.add(index);
			}

			if (hasOlder) {
				start = moveMessageWindow(length, start, "older");
			}
		} while (hasOlder);

		expect(reachable.size).toBe(length);
		expect(getMessageWindow(length, getTailWindowStart(length))).toEqual({
			start: 9750,
			end: 10000,
			hasOlder: true,
			hasNewer: false,
		});
	});

	it("keeps an overlap while exposing newly prepended history", () => {
		const previous = getMessageCollectionSignature(makeMessages(5001, messageWindowSize));
		const current = getMessageCollectionSignature(makeMessages(4001, 1250));

		expect(reconcileMessageWindow(0, previous, current, false)).toBe(875);
	});

	it("preserves an older window for scrolled-up appends", () => {
		const previous = getMessageCollectionSignature(makeMessages(1, 2000));
		const current = getMessageCollectionSignature(makeMessages(1, 2500));

		expect(reconcileMessageWindow(750, previous, current, false)).toBe(750);
	});

	it("preserves a scrolled-up window when a reconnect changes no messages", () => {
		const signature = getMessageCollectionSignature(makeMessages(1, 1000));

		expect(reconcileMessageWindow(375, signature, {...signature}, false)).toBe(375);
	});

	it("follows the tail when a capped append changes both endpoints", () => {
		const previous = getMessageCollectionSignature(makeMessages(1, 1500));
		const current = getMessageCollectionSignature(makeMessages(2, 1500));

		expect(reconcileMessageWindow(1000, previous, current, true)).toBe(1250);
	});

	it("preserves a surviving window anchor when both collection endpoints change", () => {
		const previous = getMessageCollectionSignature(makeMessages(1001, 2000));
		const currentMessages = makeMessages(1, 4000);
		const current = getMessageCollectionSignature(currentMessages);
		const preservedIndex = currentMessages.findIndex((message) => message.id === 1751);

		expect(reconcileMessageWindow(750, previous, current, false, preservedIndex)).toBe(1750);
	});

	it("finds unread boundaries in logarithmic collection lookups", () => {
		const messages = makeMessages(101, 10000);

		expect(getFirstMessageIndexAfterId(messages, 100)).toBe(0);
		expect(getFirstMessageIndexAfterId(messages, 5100)).toBe(5000);
		expect(getFirstMessageIndexAfterId(messages, 10100)).toBe(10000);
		expect(getMessageIndexById(messages, 5101)).toBe(5000);
		expect(getMessageIndexById(messages, 100)).toBe(-1);
	});

	it("centers focused and reply targets without leaving the collection", () => {
		expect(getWindowStartForIndex(10000, 20)).toBe(0);
		expect(getWindowStartForIndex(10000, 5000)).toBe(4875);
		expect(getWindowStartForIndex(10000, 9999)).toBe(9750);
	});

	it("maintains reply-parent membership incrementally, including duplicate IDs", () => {
		const messages = makeMessages(1, 10000);
		const messageIds = createMessageIdIndex(messages);
		const duplicate = {...messages[0]};
		addMessageId(messageIds, duplicate);

		expect(messageIds.size).toBe(10000);
		expect(messageIds.has("msg-1")).toBe(true);
		expect(messageIds.has("msg-10000")).toBe(true);
		expect(messageIds.has("msg-10001")).toBe(false);
		expect(messageIds.get("msg-1")).toBe(2);

		removeMessageIds(messageIds, [messages[0]]);
		expect(messageIds.get("msg-1")).toBe(1);
		removeMessageIds(messageIds, [duplicate]);
		expect(messageIds.has("msg-1")).toBe(false);
	});
});

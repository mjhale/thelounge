import {MessageType} from "../../../../shared/types/msg";
import type {ClientMessage} from "../../../../client/js/types";
import {
	createMessageIdSet,
	getMessageCollectionSignature,
	getMessageWindow,
	getTailWindowStart,
	getWindowStartForIndex,
	messageWindowSize,
	moveMessageWindow,
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
			start: 9500,
			end: 10000,
			hasOlder: true,
			hasNewer: false,
		});
	});

	it("preserves the rendered identities when history is prepended", () => {
		const previous = getMessageCollectionSignature(makeMessages(5001, messageWindowSize));
		const current = getMessageCollectionSignature(makeMessages(4001, 1500));

		expect(reconcileMessageWindow(0, previous, current, false)).toBe(1000);
	});

	it("preserves an older window for scrolled-up appends", () => {
		const previous = getMessageCollectionSignature(makeMessages(1, 2000));
		const current = getMessageCollectionSignature(makeMessages(1, 2500));

		expect(reconcileMessageWindow(750, previous, current, false)).toBe(750);
	});

	it("follows the tail when a capped append changes both endpoints", () => {
		const previous = getMessageCollectionSignature(makeMessages(1, 1500));
		const current = getMessageCollectionSignature(makeMessages(2, 1500));

		expect(reconcileMessageWindow(1000, previous, current, true)).toBe(1000);
	});

	it("centers focused and reply targets without leaving the collection", () => {
		expect(getWindowStartForIndex(10000, 20)).toBe(0);
		expect(getWindowStartForIndex(10000, 5000)).toBe(4750);
		expect(getWindowStartForIndex(10000, 9999)).toBe(9500);
	});

	it("indexes reply parents once for constant-time membership checks", () => {
		const messageIds = createMessageIdSet(makeMessages(1, 10000));

		expect(messageIds.size).toBe(10000);
		expect(messageIds.has("msg-1")).toBe(true);
		expect(messageIds.has("msg-10000")).toBe(true);
		expect(messageIds.has("msg-10001")).toBe(false);
	});
});

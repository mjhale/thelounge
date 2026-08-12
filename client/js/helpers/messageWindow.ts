import type {ClientMessage} from "../types";

export const messageWindowSize = 500;
export const messageWindowStep = 250;

export type MessageWindow = {
	start: number;
	end: number;
	hasOlder: boolean;
	hasNewer: boolean;
};

export type MessageCollectionSignature = {
	length: number;
	firstId?: number;
	lastId?: number;
};

export function getMessageWindow(length: number, requestedStart: number): MessageWindow {
	const boundedLength = Math.max(0, length);
	const maximumStart = Math.max(0, boundedLength - messageWindowSize);
	const start = Math.min(Math.max(0, requestedStart), maximumStart);
	const end = Math.min(boundedLength, start + messageWindowSize);

	return {
		start,
		end,
		hasOlder: start > 0,
		hasNewer: end < boundedLength,
	};
}

export function getTailWindowStart(length: number): number {
	return Math.max(0, length - messageWindowSize);
}

export function moveMessageWindow(
	length: number,
	start: number,
	direction: "older" | "newer"
): number {
	const offset = direction === "older" ? -messageWindowStep : messageWindowStep;
	return getMessageWindow(length, start + offset).start;
}

export function getWindowStartForIndex(length: number, index: number): number {
	return getMessageWindow(length, index - Math.floor(messageWindowSize / 2)).start;
}

export function reconcileMessageWindow(
	start: number,
	previous: MessageCollectionSignature,
	current: MessageCollectionSignature,
	atBottom: boolean
): number {
	if (atBottom || current.length <= messageWindowSize) {
		return getTailWindowStart(current.length);
	}

	const prepended =
		current.length > previous.length &&
		current.lastId === previous.lastId &&
		current.firstId !== previous.firstId;

	if (prepended) {
		return getMessageWindow(current.length, start + current.length - previous.length).start;
	}

	const appended =
		current.length >= previous.length &&
		current.firstId === previous.firstId &&
		current.lastId !== previous.lastId;

	if (appended) {
		return getMessageWindow(current.length, start).start;
	}

	return getTailWindowStart(current.length);
}

export function getMessageCollectionSignature(
	messages: readonly ClientMessage[]
): MessageCollectionSignature {
	return {
		length: messages.length,
		firstId: messages[0]?.id,
		lastId: messages.at(-1)?.id,
	};
}

export function createMessageIdSet(messages: readonly ClientMessage[]): ReadonlySet<string> {
	const messageIds = new Set<string>();

	for (const message of messages) {
		if (message.msgid) {
			messageIds.add(message.msgid);
		}
	}

	return messageIds;
}

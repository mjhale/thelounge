import type {ClientMessage} from "../types";

export const messageWindowSize = 250;
export const messageWindowStep = 125;

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

export function getFirstMessageIndexAfterId(
	messages: readonly ClientMessage[],
	messageId: number
): number {
	let low = 0;
	let high = messages.length;

	while (low < high) {
		const middle = Math.floor((low + high) / 2);

		if (messages[middle].id <= messageId) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}

	return low;
}

export function getMessageIndexById(messages: readonly ClientMessage[], messageId: number): number {
	const index = getFirstMessageIndexAfterId(messages, messageId - 1);
	return messages[index]?.id === messageId ? index : -1;
}

export function reconcileMessageWindow(
	start: number,
	previous: MessageCollectionSignature,
	current: MessageCollectionSignature,
	atBottom: boolean,
	preservedIndex = -1
): number {
	if (atBottom || current.length <= messageWindowSize) {
		return getTailWindowStart(current.length);
	}

	if (
		current.length === previous.length &&
		current.firstId === previous.firstId &&
		current.lastId === previous.lastId
	) {
		return getMessageWindow(current.length, start).start;
	}

	const prepended =
		current.length > previous.length &&
		current.lastId === previous.lastId &&
		current.firstId !== previous.firstId;

	if (prepended) {
		const loadedCount = current.length - previous.length;
		return getMessageWindow(
			current.length,
			start + loadedCount - Math.min(messageWindowStep, loadedCount)
		).start;
	}

	const appended =
		current.length >= previous.length &&
		current.firstId === previous.firstId &&
		current.lastId !== previous.lastId;

	if (appended) {
		return getMessageWindow(current.length, start).start;
	}

	if (preservedIndex >= 0) {
		return getMessageWindow(current.length, preservedIndex).start;
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

export function createMessageIdIndex(messages: readonly ClientMessage[]): Map<string, number> {
	const messageIds = new Map<string, number>();

	for (const message of messages) {
		addMessageId(messageIds, message);
	}

	return messageIds;
}

export function addMessageId(messageIds: Map<string, number>, message: ClientMessage): void {
	if (message.msgid) {
		messageIds.set(message.msgid, (messageIds.get(message.msgid) ?? 0) + 1);
	}
}

export function removeMessageIds(
	messageIds: Map<string, number>,
	messages: readonly ClientMessage[]
): void {
	for (const message of messages) {
		if (!message.msgid) {
			continue;
		}

		const count = messageIds.get(message.msgid) ?? 0;

		if (count > 1) {
			messageIds.set(message.msgid, count - 1);
		} else {
			messageIds.delete(message.msgid);
		}
	}
}

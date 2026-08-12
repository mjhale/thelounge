import type {ClientChan} from "../types";

export type HistoryRequest = {
	target: number;
	lastId: number;
	condensed: boolean;
};

export function beginHistoryRequest(
	channel: ClientChan,
	isConnected: boolean,
	condensed: boolean
): HistoryRequest | undefined {
	if (!isConnected || channel.historyLoading || !channel.moreHistoryAvailable) {
		return undefined;
	}

	const firstChannelMessage = channel.messages.find((message) => !message.showInActive);
	channel.historyLoading = true;

	return {
		target: channel.id,
		lastId: firstChannelMessage?.id ?? -1,
		condensed,
	};
}

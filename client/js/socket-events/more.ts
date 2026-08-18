import {nextTick} from "vue";

import socket from "../socket";
import {store} from "../store";
import {extractInputHistory} from "../helpers/inputHistory";
import {addMessageId} from "../helpers/messageWindow";

socket.on("more", async (data) => {
	const channel = store.getters.findChannel(data.chan)?.channel;

	if (!channel) {
		return;
	}

	channel.inputHistory = channel.inputHistory.concat(
		extractInputHistory(data.messages, 100 - channel.inputHistory.length)
	);
	channel.moreHistoryAvailable =
		data.totalMessages > channel.messages.length + data.messages.length;

	for (const message of data.messages) {
		addMessageId(channel.messageIds, message);
	}

	channel.messages = data.messages.concat(channel.messages);

	await nextTick();
	channel.historyLoading = false;
});

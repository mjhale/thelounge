<template>
	<div ref="chat" class="chat" tabindex="-1">
		<div
			v-show="channel.moreHistoryAvailable || messageWindow.hasOlder"
			:aria-busy="channel.historyLoading || undefined"
			class="show-more"
			data-message-window="older"
		>
			<button
				ref="loadMoreButton"
				:aria-disabled="windowTransitioning || undefined"
				:disabled="
					!messageWindow.hasOlder && (channel.historyLoading || !store.state.isConnected)
				"
				class="btn"
				@click="showOlderMessages"
			>
				<span v-if="channel.historyLoading && !messageWindow.hasOlder">Loading…</span>
				<span v-else-if="messageWindow.hasOlder">Show older loaded messages</span>
				<span v-else>Load older messages</span>
			</button>
		</div>
		<div
			id="chat-messages"
			ref="messageContainer"
			class="messages"
			:data-retained-count="channel.messages.length"
			:data-retained-first-id="channel.messages[0]?.id"
			:data-retained-last-id="channel.messages.at(-1)?.id"
			:data-status-messages="store.state.settings.statusMessages"
			:data-window-start="messageWindow.start"
			:data-window-end="messageWindow.end"
			role="log"
			aria-live="polite"
			aria-relevant="additions"
			@copy="onCopy"
		>
			<template v-for="(message, id) in condensedMessages">
				<DateMarker
					v-if="shouldDisplayDateMarker(message, id)"
					:key="message.id + '-date'"
					:message="message as any"
					:focused="message.id === focused"
				/>
				<div
					v-if="shouldDisplayUnreadMarker(message)"
					:key="message.id + '-unread'"
					class="unread-marker"
				>
					<span class="unread-marker-text" />
				</div>

				<MessageCondensed
					v-if="message.type === 'condensed'"
					:key="message.messages[0].id"
					:network="network"
					:keep-scroll-position="keepScrollPosition"
					:messages="message.messages"
					:message-ids="channel.messageIds"
					:reveal-message="revealMessageByMsgid"
					:focused="focused"
				/>
				<Message
					v-else
					:key="message.id"
					:channel="channel"
					:network="network"
					:message="message"
					:message-ids="channel.messageIds"
					:reveal-message="revealMessageByMsgid"
					:keep-scroll-position="keepScrollPosition"
					:is-previous-source="isPreviousSource(message, id)"
					:focused="message.id === focused"
					@toggle-link-preview="onLinkPreviewToggle"
				/>
			</template>
		</div>
		<div
			v-show="messageWindow.hasNewer"
			class="show-more show-newer"
			data-message-window="newer"
		>
			<button
				:aria-disabled="windowTransitioning || undefined"
				class="btn"
				@click="showNewerMessages"
			>
				Show newer loaded messages
			</button>
		</div>
	</div>
</template>

<script lang="ts">
import {condensedTypes} from "../../shared/irc";
import {ChanType} from "../../shared/types/chan";
import {MessageType, SharedMsg} from "../../shared/types/msg";
import eventbus from "../js/eventbus";
import clipboard from "../js/clipboard";
import socket from "../js/socket";
import Message from "./Message.vue";
import MessageCondensed from "./MessageCondensed.vue";
import DateMarker from "./DateMarker.vue";
import {
	computed,
	defineComponent,
	nextTick,
	onBeforeUnmount,
	onMounted,
	onUnmounted,
	PropType,
	ref,
	watch,
} from "vue";
import {useStore} from "../js/store";
import {ClientChan, ClientMessage, ClientNetwork, ClientLinkPreview} from "../js/types";
import {beginHistoryRequest} from "../js/helpers/historyRequest";
import {
	getMessageCollectionSignature,
	getFirstMessageIndexAfterId,
	getMessageIndexById,
	getMessageWindow,
	getTailWindowStart,
	getWindowStartForIndex,
	moveMessageWindow,
	reconcileMessageWindow,
} from "../js/helpers/messageWindow";

type CondensedMessageContainer = {
	type: "condensed";
	time: Date;
	messages: ClientMessage[];
	id?: number;
};

type ScrollAnchor = {
	messageId: number;
	top: number;
	condensed: boolean;
};

export default defineComponent({
	name: "MessageList",
	components: {
		Message,
		MessageCondensed,
		DateMarker,
	},
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
		channel: {type: Object as PropType<ClientChan>, required: true},
		focused: Number,
	},
	setup(props) {
		const store = useStore();

		const chat = ref<HTMLDivElement | null>(null);
		const messageContainer = ref<HTMLDivElement | null>(null);
		const loadMoreButton = ref<HTMLButtonElement | null>(null);
		const historyObserver = ref<IntersectionObserver | null>(null);
		const messageResizeObserver = ref<ResizeObserver | null>(null);
		const skipNextScrollEvent = ref(false);
		const windowTransitioning = ref(false);
		let windowScrollAnchor: ScrollAnchor | undefined;
		let resizeScrollAnchor: ScrollAnchor | undefined;
		let focusedRevealSequence = 0;
		let scrollAnchorGeneration = 0;
		let trackedWindowFirstId =
			props.channel.messages[
				getMessageWindow(props.channel.messages.length, props.channel.messageWindowStart)
					.start
			]?.id;

		const updateTrackedWindowFirstId = () => {
			trackedWindowFirstId =
				props.channel.messages[
					getMessageWindow(
						props.channel.messages.length,
						props.channel.messageWindowStart
					).start
				]?.id;
		};

		const jumpToBottom = () => {
			scrollAnchorGeneration++;
			props.channel.scrolledToBottom = true;
			props.channel.messageWindowStart = getTailWindowStart(props.channel.messages.length);
			resizeScrollAnchor = undefined;
			updateTrackedWindowFirstId();

			const el = chat.value;

			if (el) {
				void nextTick(() => {
					const target = Math.max(0, el.scrollHeight - el.clientHeight);

					if (Math.abs(el.scrollTop - target) > 1) {
						skipNextScrollEvent.value = true;
						el.scrollTop = target;
					}
				});
			}
		};

		const onShowMoreClick = () => {
			const request = beginHistoryRequest(
				props.channel,
				store.state.isConnected,
				store.state.settings.statusMessages !== "shown"
			);

			if (!request) {
				return;
			}

			socket.emit("more", request);
		};

		const onLoadButtonObserved = (entries: IntersectionObserverEntry[]) => {
			entries.forEach((entry) => {
				if (!entry.isIntersecting) {
					return;
				}

				if (
					!getMessageWindow(
						props.channel.messages.length,
						props.channel.messageWindowStart
					).hasOlder
				) {
					onShowMoreClick();
				}
			});
		};

		const messageWindow = computed(() =>
			getMessageWindow(props.channel.messages.length, props.channel.messageWindowStart)
		);
		const renderedMessages = computed(() =>
			props.channel.messages.slice(messageWindow.value.start, messageWindow.value.end)
		);

		const condensedMessages = computed(() => {
			if (props.channel.type !== ChanType.CHANNEL && props.channel.type !== ChanType.QUERY) {
				return renderedMessages.value;
			}

			// If actions are hidden, just return a message list with them excluded
			if (store.state.settings.statusMessages === "hidden") {
				return renderedMessages.value.filter(
					(message) => !condensedTypes.has(message.type || "")
				);
			}

			// If actions are not condensed, just return raw message list
			if (store.state.settings.statusMessages !== "condensed") {
				return renderedMessages.value;
			}

			let lastCondensedContainer: CondensedMessageContainer | null = null;

			const condensed: (ClientMessage | CondensedMessageContainer)[] = [];

			for (const message of renderedMessages.value) {
				// If this message is not condensable, or its an action affecting our user,
				// then just append the message to container and be done with it
				if (message.self || message.highlight || !condensedTypes.has(message.type || "")) {
					lastCondensedContainer = null;

					condensed.push(message);

					continue;
				}

				if (!lastCondensedContainer) {
					lastCondensedContainer = {
						time: message.time,
						type: "condensed",
						messages: [],
					};

					condensed.push(lastCondensedContainer);
				}

				lastCondensedContainer!.messages.push(message);

				// Set id of the condensed container to last message id,
				// which is required for the unread marker to work correctly
				lastCondensedContainer!.id = message.id;

				// If this message is the unread boundary, create a split condensed container
				if (message.id === props.channel.firstUnread) {
					lastCondensedContainer = null;
				}
			}

			return condensed.map((message) => {
				// Skip condensing single messages, it doesn't save any
				// space but makes useful information harder to see
				if (message.type === "condensed" && message.messages.length === 1) {
					return message.messages[0];
				}

				return message;
			});
		});

		const shouldDisplayDateMarker = (
			message: SharedMsg | CondensedMessageContainer,
			id: number
		) => {
			let previousMessage = condensedMessages.value[id - 1];

			if (!previousMessage) {
				const firstId =
					message.type === "condensed" ? message.messages[0].id : Number(message.id);
				let previousIndex = getMessageIndexById(props.channel.messages, firstId) - 1;

				if (store.state.settings.statusMessages === "hidden") {
					while (
						previousIndex >= 0 &&
						condensedTypes.has(props.channel.messages[previousIndex].type || "")
					) {
						previousIndex--;
					}
				}

				previousMessage = props.channel.messages[previousIndex];
			}

			if (!previousMessage) {
				return true;
			}

			const previousTime =
				previousMessage.type === "condensed"
					? previousMessage.messages.at(-1)!.time
					: previousMessage.time;
			const oldDate = new Date(previousTime);
			const newDate = new Date(message.time);

			return (
				oldDate.getDate() !== newDate.getDate() ||
				oldDate.getMonth() !== newDate.getMonth() ||
				oldDate.getFullYear() !== newDate.getFullYear()
			);
		};

		const unreadBoundaryId = computed(() => {
			const hideStatusMessages = store.state.settings.statusMessages === "hidden";
			let index = getFirstMessageIndexAfterId(
				props.channel.messages,
				props.channel.firstUnread
			);

			if (hideStatusMessages) {
				while (
					index < props.channel.messages.length &&
					condensedTypes.has(props.channel.messages[index].type || "")
				) {
					index++;
				}
			}

			return props.channel.messages[index]?.id;
		});

		const shouldDisplayUnreadMarker = (message: ClientMessage | CondensedMessageContainer) => {
			const boundaryId = unreadBoundaryId.value;

			if (boundaryId === undefined) {
				return false;
			}

			return message.type === "condensed"
				? message.messages.some((candidate) => candidate.id === boundaryId)
				: message.id === boundaryId;
		};

		const isPreviousSource = (currentMessage: ClientMessage, id: number) => {
			const previousMessage = condensedMessages.value[id - 1];
			return (
				previousMessage &&
				currentMessage.type === MessageType.MESSAGE &&
				previousMessage.type === MessageType.MESSAGE &&
				currentMessage.from &&
				previousMessage.from &&
				currentMessage.from.nick === previousMessage.from.nick
			);
		};

		const onCopy = () => {
			if (chat.value) {
				clipboard(chat.value);
			}
		};

		const getScrollAnchor = (
			el: HTMLElement,
			anchorEdge: "first" | "last",
			visibleOnly = false
		): ScrollAnchor | undefined => {
			const chatBounds = el.getBoundingClientRect();

			const isVisible = (element: HTMLElement) => {
				const bounds = element.getBoundingClientRect();
				return (
					bounds.height > 0 &&
					bounds.bottom > chatBounds.top &&
					bounds.top < chatBounds.bottom
				);
			};

			const messages = Array.from(
				el.querySelectorAll<HTMLElement>('.messages [id^="msg-"]')
			).filter((element) => !visibleOnly || isVisible(element));
			const message = anchorEdge === "first" ? messages[0] : messages[messages.length - 1];

			if (message) {
				return {
					messageId: Number(message.id.slice(4)),
					top: message.getBoundingClientRect().top,
					condensed: false,
				};
			}

			const containers = Array.from(
				el.querySelectorAll<HTMLElement>('.messages > .msg[data-type="condensed"]')
			).filter((element) => !visibleOnly || isVisible(element));
			const container =
				anchorEdge === "first" ? containers[0] : containers[containers.length - 1];

			if (!container) {
				return;
			}

			return {
				messageId: Number(
					anchorEdge === "first"
						? container.dataset.lastMessageId
						: container.dataset.firstMessageId
				),
				top: container.getBoundingClientRect().top,
				condensed: true,
			};
		};

		const restoreScrollAnchor = (el: HTMLElement, anchor: ScrollAnchor | undefined) => {
			if (!anchor || !Number.isFinite(anchor.messageId)) {
				return false;
			}

			let nextAnchor = anchor.condensed
				? undefined
				: el.querySelector<HTMLElement>(`#msg-${anchor.messageId}`) ?? undefined;

			if (!nextAnchor) {
				nextAnchor = Array.from(
					el.querySelectorAll<HTMLElement>('.messages > .msg[data-type="condensed"]')
				).find(
					(container) =>
						Number(container.dataset.firstMessageId) <= anchor.messageId &&
						Number(container.dataset.lastMessageId) >= anchor.messageId
				);
			}

			if (!nextAnchor) {
				return false;
			}

			const delta = nextAnchor.getBoundingClientRect().top - anchor.top;

			if (Math.abs(delta) > 0.5) {
				skipNextScrollEvent.value = true;
				el.scrollTop += delta;
			}

			return true;
		};

		const rememberVisibleScrollAnchor = () => {
			const el = chat.value;

			resizeScrollAnchor =
				el && !props.channel.scrolledToBottom
					? getScrollAnchor(el, "first", true)
					: undefined;
		};

		const handleMessageResize = () => {
			const el = chat.value;

			if (!el || props.channel.scrolledToBottom) {
				resizeScrollAnchor = undefined;
				return;
			}

			const anchor = windowScrollAnchor ?? resizeScrollAnchor;

			if (restoreScrollAnchor(el, anchor)) {
				resizeScrollAnchor = anchor;
			} else {
				rememberVisibleScrollAnchor();
			}
		};

		const keepScrollPosition = async () => {
			const el = chat.value;

			if (!el) {
				return;
			}

			const generation = scrollAnchorGeneration;

			if (windowTransitioning.value) {
				const anchor = windowScrollAnchor;

				await nextTick();

				if (generation === scrollAnchorGeneration && restoreScrollAnchor(el, anchor)) {
					resizeScrollAnchor = anchor;
				}

				return;
			}

			if (!props.channel.scrolledToBottom) {
				const anchor = resizeScrollAnchor ?? getScrollAnchor(el, "first", true);
				const heightOld = props.channel.historyLoading
					? el.scrollHeight - el.scrollTop
					: undefined;
				const overflowAnchor = el.style.overflowAnchor;

				if (heightOld !== undefined) {
					el.style.overflowAnchor = "none";
				}

				try {
					await nextTick();

					if (generation !== scrollAnchorGeneration) {
						return;
					}

					const anchorRestored = restoreScrollAnchor(el, anchor);

					if (anchorRestored && heightOld !== undefined) {
						for (let frame = 0; frame < 2; frame++) {
							await new Promise<void>((resolve) =>
								requestAnimationFrame(() => resolve())
							);

							if (generation === scrollAnchorGeneration) {
								restoreScrollAnchor(el, anchor);
							}
						}
					}

					if (anchorRestored) {
						resizeScrollAnchor = anchor;
					} else if (heightOld !== undefined) {
						const target = el.scrollHeight - heightOld;

						if (Math.abs(el.scrollTop - target) > 1) {
							skipNextScrollEvent.value = true;
							el.scrollTop = target;
						}

						rememberVisibleScrollAnchor();
					} else {
						rememberVisibleScrollAnchor();
					}
				} finally {
					if (heightOld !== undefined) {
						el.style.overflowAnchor = overflowAnchor;
					}
				}

				return;
			}

			await nextTick();

			if (generation === scrollAnchorGeneration && props.channel.scrolledToBottom) {
				jumpToBottom();
			}
		};

		const keepAnchorWhile = async (updateWindow: () => void, anchorEdge: "first" | "last") => {
			const el = chat.value;

			if (!el) {
				updateWindow();
				return;
			}

			const anchor = getScrollAnchor(el, anchorEdge);
			const overflowAnchor = el.style.overflowAnchor;
			const generation = ++scrollAnchorGeneration;
			windowScrollAnchor = anchor;
			resizeScrollAnchor = anchor;
			el.style.overflowAnchor = "none";

			try {
				updateWindow();
				await nextTick();

				if (generation === scrollAnchorGeneration) {
					restoreScrollAnchor(el, anchor);
				}

				for (let frame = 0; frame < 2; frame++) {
					await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

					if (generation === scrollAnchorGeneration) {
						restoreScrollAnchor(el, anchor);
					}
				}

				if (generation === scrollAnchorGeneration) {
					resizeScrollAnchor = anchor;
				}
			} finally {
				windowScrollAnchor = undefined;
				el.style.overflowAnchor = overflowAnchor;
			}
		};

		const showOlderMessages = async () => {
			if (windowTransitioning.value) {
				return;
			}

			if (!messageWindow.value.hasOlder) {
				onShowMoreClick();
				return;
			}

			windowTransitioning.value = true;

			try {
				props.channel.scrolledToBottom = false;
				await keepAnchorWhile(() => {
					props.channel.messageWindowStart = moveMessageWindow(
						props.channel.messages.length,
						props.channel.messageWindowStart,
						"older"
					);
					updateTrackedWindowFirstId();
				}, "first");
			} finally {
				windowTransitioning.value = false;
			}
		};

		const showNewerMessages = async () => {
			if (windowTransitioning.value) {
				return;
			}

			const nextStart = moveMessageWindow(
				props.channel.messages.length,
				props.channel.messageWindowStart,
				"newer"
			);
			windowTransitioning.value = true;

			try {
				props.channel.scrolledToBottom = false;
				await keepAnchorWhile(() => {
					props.channel.messageWindowStart = nextStart;
					updateTrackedWindowFirstId();
				}, "last");

				if (!getMessageWindow(props.channel.messages.length, nextStart).hasNewer) {
					jumpToBottom();
				}
			} finally {
				windowTransitioning.value = false;
			}
		};

		const revealMessage = async (
			messageId: number,
			isCurrent: () => boolean = () => true
		): Promise<boolean> => {
			const index = props.channel.messages.findIndex((message) => message.id === messageId);

			if (index < 0 || !isCurrent()) {
				return false;
			}

			props.channel.scrolledToBottom = false;
			scrollAnchorGeneration++;
			props.channel.messageWindowStart = getWindowStartForIndex(
				props.channel.messages.length,
				index
			);
			updateTrackedWindowFirstId();
			await nextTick();
			await nextTick();

			if (!isCurrent()) {
				return false;
			}

			const message = chat.value?.querySelector<HTMLElement>(`#msg-${messageId}`);

			if (!message) {
				return false;
			}

			scrollAnchorGeneration++;
			message.scrollIntoView({block: "center"});
			resizeScrollAnchor = {
				messageId,
				top: message.getBoundingClientRect().top,
				condensed: false,
			};
			return true;
		};

		const syncFocusedMessage = async (focused: number | undefined) => {
			const sequence = ++focusedRevealSequence;
			const isCurrent = () => sequence === focusedRevealSequence;
			const revealed = Number.isFinite(focused)
				? await revealMessage(Number(focused), isCurrent)
				: false;

			if (isCurrent() && !revealed) {
				jumpToBottom();
			}
		};

		const revealMessageByMsgid = async (msgid: string) => {
			const message = props.channel.messages.find((candidate) => candidate.msgid === msgid);

			if (message) {
				await revealMessage(message.id);
			}
		};

		const onLinkPreviewToggle = async (preview: ClientLinkPreview, message: ClientMessage) => {
			await keepScrollPosition();

			// Tell the server we're toggling so it remembers at page reload
			socket.emit("msg:preview:toggle", {
				target: props.channel.id,
				msgId: message.id,
				link: preview.link,
				shown: preview.shown,
			});
		};

		const handleScroll = () => {
			// Setting scrollTop also triggers scroll event
			// We don't want to perform calculations for that
			if (skipNextScrollEvent.value) {
				skipNextScrollEvent.value = false;
				return;
			}

			const el = chat.value;

			if (!el) {
				return;
			}

			scrollAnchorGeneration++;

			props.channel.scrolledToBottom =
				!messageWindow.value.hasNewer &&
				el.scrollHeight - el.scrollTop - el.offsetHeight <= 30;
			rememberVisibleScrollAnchor();
		};

		const handleResize = () => {
			// Keep message list scrolled to bottom on resize
			if (props.channel.scrolledToBottom) {
				jumpToBottom();
			}
		};

		onMounted(() => {
			chat.value?.addEventListener("scroll", handleScroll, {passive: true});

			eventbus.on("resize", handleResize);

			void nextTick()
				.then(async () => {
					if (window.IntersectionObserver && chat.value) {
						historyObserver.value = new window.IntersectionObserver(
							onLoadButtonObserved,
							{root: chat.value}
						);
					}

					if (window.ResizeObserver && messageContainer.value) {
						messageResizeObserver.value = new window.ResizeObserver(
							handleMessageResize
						);
						messageResizeObserver.value.observe(messageContainer.value);
					}

					if (historyObserver.value && loadMoreButton.value) {
						historyObserver.value.observe(loadMoreButton.value);
					}

					await syncFocusedMessage(props.focused);
				})
				.catch((e) => {
					// eslint-disable-next-line no-console
					console.error("Error while initializing message list", e);
				});
		});

		watch(
			() => [props.channel.id, props.focused, store.state.settings.statusMessages] as const,
			async (
				[channelId, focused, statusMessages],
				[previousChannelId, previousFocused, previousStatusMessages]
			) => {
				const channelChanged = channelId !== previousChannelId;
				const focusChanged = !Object.is(focused, previousFocused);

				if (channelChanged || focusChanged || Number.isFinite(focused)) {
					await syncFocusedMessage(focused);
				} else if (statusMessages !== previousStatusMessages) {
					await keepScrollPosition();
				}

				if (channelChanged) {
					// Re-add the intersection observer to trigger the check again on channel switch
					// Otherwise if last channel had the button visible, switching to a new channel won't trigger the history
					if (historyObserver.value && loadMoreButton.value) {
						historyObserver.value.disconnect();
						historyObserver.value.observe(loadMoreButton.value);
					}
				}
			}
		);

		watch(
			() => getMessageCollectionSignature(props.channel.messages),
			async (current, previous) => {
				const shouldFindPreservedIndex =
					!props.channel.scrolledToBottom &&
					current.firstId !== previous.firstId &&
					current.lastId !== previous.lastId;
				const preservedIndex = shouldFindPreservedIndex
					? props.channel.messages.findIndex(
							(message) => message.id === trackedWindowFirstId
					  )
					: -1;
				props.channel.messageWindowStart = reconcileMessageWindow(
					props.channel.messageWindowStart,
					previous,
					current,
					props.channel.scrolledToBottom,
					preservedIndex
				);
				updateTrackedWindowFirstId();
				await keepScrollPosition();
			},
			{deep: true}
		);

		onBeforeUnmount(() => {
			focusedRevealSequence++;
			eventbus.off("resize", handleResize);
			chat.value?.removeEventListener("scroll", handleScroll);
		});

		onUnmounted(() => {
			if (historyObserver.value) {
				historyObserver.value.disconnect();
			}

			if (messageResizeObserver.value) {
				messageResizeObserver.value.disconnect();
			}
		});

		return {
			chat,
			messageContainer,
			store,
			onShowMoreClick,
			loadMoreButton,
			onCopy,
			condensedMessages,
			messageWindow,
			windowTransitioning,
			shouldDisplayDateMarker,
			shouldDisplayUnreadMarker,
			keepScrollPosition,
			isPreviousSource,
			jumpToBottom,
			showOlderMessages,
			showNewerMessages,
			revealMessageByMsgid,
			onLinkPreviewToggle,
		};
	},
});
</script>

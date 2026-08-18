<template>
	<div
		:class="['msg', {closed: isCollapsed}]"
		:data-first-message-id="messages[0].id"
		:data-last-message-id="messages.at(-1)?.id"
		data-type="condensed"
	>
		<div class="condensed-summary">
			<span class="time" />
			<span class="from" />
			<span class="content" @click="onCollapseClick"
				>{{ condensedText
				}}<button
					class="toggle-button"
					aria-label="Toggle status messages"
					:aria-expanded="!isCollapsed"
			/></span>
		</div>
		<template v-if="!isCollapsed">
			<Message
				v-for="message in messages"
				:key="message.id"
				:network="network"
				:message="message"
				:message-ids="messageIds"
				:reveal-message="revealMessage"
				:focused="message.id === focused"
			/>
		</template>
	</div>
</template>

<script lang="ts">
import {computed, defineComponent, PropType, ref, watch} from "vue";
import {condensedTypes} from "../../shared/irc";
import {MessageType} from "../../shared/types/msg";
import {ClientMessage, ClientNetwork} from "../js/types";
import Message from "./Message.vue";

export default defineComponent({
	name: "MessageCondensed",
	components: {
		Message,
	},
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
		messages: {
			type: Array as PropType<ClientMessage[]>,
			required: true,
		},
		keepScrollPosition: {
			type: Function as PropType<() => void>,
			required: true,
		},
		focused: Number,
		messageIds: {
			type: Object as PropType<ReadonlyMap<string, number>>,
			required: false,
		},
		revealMessage: Function as PropType<(msgid: string) => Promise<void>>,
	},
	setup(props) {
		const isCollapsed = ref(true);

		watch(
			() => props.focused,
			(focused) => {
				if (props.messages.some((message) => message.id === focused)) {
					isCollapsed.value = false;
				}
			},
			{immediate: true}
		);

		const onCollapseClick = () => {
			isCollapsed.value = !isCollapsed.value;
			props.keepScrollPosition();
		};

		const condensedText = computed(() => {
			const obj: Record<string, number> = {};

			condensedTypes.forEach((type) => {
				obj[type] = 0;
			});

			for (const message of props.messages) {
				// special case since one MODE message can change multiple modes
				if (message.type === MessageType.MODE) {
					// syntax: +vv-t maybe-some targets
					// we want the number of mode changes in the message, so count the
					// number of chars other than + and - before the first space
					const text = message.text ? message.text : "";
					const modeChangesCount = text
						.split(" ")[0]
						.split("")
						.filter((char) => char !== "+" && char !== "-").length;
					obj[message.type] += modeChangesCount;
				} else {
					if (!message.type) {
						/* eslint-disable no-console */
						console.log(`empty message type, this should not happen: ${message.id}`);
						continue;
					}

					obj[message.type]++;
				}
			}

			// Count quits as parts in condensed messages to reduce information density
			obj.part += obj.quit;

			const strings: string[] = [];
			condensedTypes.forEach((type) => {
				if (obj[type]) {
					switch (type) {
						case "chghost":
							strings.push(
								String(obj[type]) +
									(obj[type] > 1
										? " users have changed hostname"
										: " user has changed hostname")
							);
							break;
						case "join":
							strings.push(
								String(obj[type]) +
									(obj[type] > 1 ? " users have joined" : " user has joined")
							);
							break;
						case "part":
							strings.push(
								String(obj[type]) +
									(obj[type] > 1 ? " users have left" : " user has left")
							);
							break;
						case "nick":
							strings.push(
								String(obj[type]) +
									(obj[type] > 1
										? " users have changed nick"
										: " user has changed nick")
							);
							break;
						case "kick":
							strings.push(
								String(obj[type]) +
									(obj[type] > 1 ? " users were kicked" : " user was kicked")
							);
							break;
						case "mode":
							strings.push(
								String(obj[type]) +
									(obj[type] > 1 ? " modes were set" : " mode was set")
							);
							break;
						case "away":
							strings.push(
								"marked away " +
									(obj[type] > 1 ? String(obj[type]) + " times" : "once")
							);
							break;
						case "back":
							strings.push(
								"marked back " +
									(obj[type] > 1 ? String(obj[type]) + " times" : "once")
							);
							break;
					}
				}
			});

			if (strings.length) {
				let text = strings.pop();

				if (strings.length) {
					text = strings.join(", ") + ", and " + text!;
				}

				return text;
			}

			return "";
		});

		return {
			isCollapsed,
			condensedText,
			onCollapseClick,
		};
	},
});
</script>

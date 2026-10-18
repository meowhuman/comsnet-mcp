export interface CompletionEvent {
	msg_id: string;
	from: string;
	response: unknown;
	error: string | null;
}

export interface CompletionMessage {
	customType: 'coms-net-response';
	content: string;
	display: true;
	details: CompletionEvent;
}

type SendMessage = (
	message: CompletionMessage,
	options: { deliverAs: 'followUp'; triggerTurn: true },
) => void;

function responseText(response: unknown): string {
	if (typeof response === 'string') return response;
	if (response === undefined) return '';
	try {
		return JSON.stringify(response, null, 2);
	} catch {
		return String(response);
	}
}

/**
 * Return only an inbound message attached to the agent_end event that just ran.
 * Never infer a reply target from older branch history or queue ordering.
 */
export function inboundMessageIdFromEvent(messages: readonly unknown[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as {
			role?: unknown;
			customType?: unknown;
			details?: { msg_id?: unknown };
		};
		if (message?.role !== 'custom' || message.customType !== 'coms-net-inbound') continue;
		if (typeof message.details?.msg_id === 'string' && message.details.msg_id) {
			return message.details.msg_id;
		}
	}
	return null;
}

/**
 * Push a completed outbound response into the sender turn exactly once per msg_id.
 */
export function createCompletionNotifier(sendMessage: SendMessage): (event: CompletionEvent) => boolean {
	const notified = new Set<string>();
	return (event) => {
		if (!event.msg_id || notified.has(event.msg_id)) return false;
		notified.add(event.msg_id);
		const outcome = event.error ? `error: ${event.error}` : responseText(event.response);
		sendMessage(
			{
				customType: 'coms-net-response',
				content:
					`[coms-net reply from ${event.from}]\n` +
					`[msg_id ${event.msg_id}; this completes your earlier outbound message]\n\n${outcome}`,
				display: true,
				details: event,
			},
			{ deliverAs: 'followUp', triggerTurn: true },
		);
		return true;
	};
}

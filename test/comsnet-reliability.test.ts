import { expect, test } from 'bun:test';
import {
	createCompletionNotifier,
	inboundMessageIdFromEvent,
	type CompletionMessage,
} from '../src/lib/coms-net-reliability.ts';

test('pushes each Pi sender completion once as a follow-up turn', () => {
	const calls: Array<{ message: CompletionMessage; options: unknown }> = [];
	const notify = createCompletionNotifier((message, options) => calls.push({ message, options }));

	expect(notify({ msg_id: 'out-1', from: 'worker', response: 'done', error: null })).toBe(true);
	expect(notify({ msg_id: 'out-1', from: 'worker', response: 'done', error: null })).toBe(false);
	expect(calls).toHaveLength(1);
	expect(calls[0]).toEqual({
		message: expect.objectContaining({
			customType: 'coms-net-response',
			content: expect.stringContaining('done'),
			details: expect.objectContaining({ msg_id: 'out-1' }),
		}),
		options: { deliverAs: 'followUp', triggerTurn: true },
	});
});

test('correlates agent_end only with the newest inbound custom message in that event', () => {
	const eventMessages = [
		{ role: 'custom', customType: 'coms-net-inbound', details: { msg_id: 'old-inbound' } },
		{ role: 'assistant', content: [{ type: 'text', text: 'unrelated prior answer' }] },
		{ role: 'custom', customType: 'coms-net-inbound', details: { msg_id: 'current-inbound' } },
		{ role: 'assistant', content: [{ type: 'text', text: 'current answer' }] },
	];

	expect(inboundMessageIdFromEvent(eventMessages)).toBe('current-inbound');
	expect(inboundMessageIdFromEvent([{ role: 'assistant', content: [] }])).toBeNull();
});

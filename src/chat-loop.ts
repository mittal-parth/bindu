import type { Interface as ReadlineInterface } from "node:readline";

export type ChatIo = {
	/** Next line of user input, or null when the terminal closes. */
	readLine: () => Promise<string | null>;
	write: (text: string) => void;
};

export type AgentTurn = {
	/**
	 * Run one turn. Call `emit` with each text chunk as it arrives.
	 * Return text to print after the turn: the full reply when nothing was
	 * streamed, or only a trailing note (such as a stop reason) when it was.
	 */
	send: (text: string, emit: (chunk: string) => void) => Promise<string>;
};

type MessageBlock = {
	type: string;
	text?: string;
};

export function isExitCommand(line: string): boolean {
	const command = line.trim().toLowerCase();
	return command === "/exit" || command === "/quit";
}

export function formatAgentMessage(content: readonly MessageBlock[]): string {
	const text = content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("")
		.trim();
	return text.length > 0 ? text : "(no reply)";
}

export function formatTurn(
	content: readonly MessageBlock[],
	stopReason: string,
): string {
	const text = formatAgentMessage(content);
	const suffix = streamedStopSuffix(stopReason);
	return suffix.length > 0 ? `${text}${suffix}` : text;
}

/** Trailing note for a turn whose text was already written chunk by chunk. */
export function streamedStopSuffix(stopReason: string): string {
	if (stopReason === "end_turn") return "";
	return `\n(${stopReason})`;
}

/** Live text from a session event. Durable copies of the same reply are ignored. */
export function messageChunkText(event: unknown): string | null {
	if (typeof event !== "object" || event === null) return null;
	if (!("durability" in event) || event.durability !== "ephemeral") return null;
	if (!("type" in event) || event.type !== "agent_message_chunk") return null;
	if (!("content" in event)) return null;

	const content = event.content;
	if (typeof content !== "object" || content === null) return null;
	if (!("type" in content) || content.type !== "text") return null;
	if (!("text" in content) || typeof content.text !== "string") return null;
	return content.text;
}

/** Next terminal line. Stdin can close while lines are still buffered, so a closed
 * interface is still drained before the chat ends. */
export async function readChatLine(
	rl: ReadlineInterface,
	lines: AsyncIterator<string>,
): Promise<string | null> {
	if (!readlineIsClosed(rl)) {
		try {
			rl.prompt();
		} catch (error) {
			if (!isReadlineClosed(error)) throw error;
		}
	}

	const next = await lines.next();
	return next.done ? null : next.value;
}

function readlineIsClosed(rl: ReadlineInterface): boolean {
	const state: object = rl;
	return "closed" in state && state.closed === true;
}

function isReadlineClosed(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ERR_USE_AFTER_CLOSE"
	);
}

/** One session, one turn at a time, until the user exits or the terminal closes. */
export async function runChat(io: ChatIo, agent: AgentTurn): Promise<void> {
	for (;;) {
		const line = await io.readLine();
		if (line === null || isExitCommand(line)) return;

		const text = line.trim();
		if (text.length === 0) continue;

		let streamed = false;
		try {
			const reply = await agent.send(text, (chunk) => {
				if (!streamed) io.write("agent> ");
				streamed = true;
				io.write(chunk);
			});
			if (streamed) {
				if (reply.length > 0) io.write(reply);
				io.write("\n\n");
			} else {
				io.write(`agent> ${reply}\n\n`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (streamed) io.write("\n");
			io.write(`error: ${message}\n\n`);
		}
	}
}

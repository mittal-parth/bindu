import { createClient } from "@rivet-dev/agentos/client";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { registry } from "./server";
import {
	formatTurn,
	messageChunkText,
	readChatLine,
	runChat,
	streamedStopSuffix,
} from "./chat-loop";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
	console.error("ANTHROPIC_API_KEY is not set.");
	process.exit(1);
}

const client = createClient<typeof registry>({
	endpoint: "http://localhost:6420",
});
const agent = client.vm.getOrCreate("my-agent-2");

await agent.sessions.open({
	agent: "pi",
	env: { ANTHROPIC_API_KEY: apiKey },
});

const conn = agent.connect();
let emitChunk: ((chunk: string) => void) | null = null;
conn.on("sessionEvent", (event) => {
	if (emitChunk === null) return;
	const chunk = messageChunkText(event);
	if (chunk === null) return;
	emitChunk(chunk);
});

const rl = readline.createInterface({ input, output, prompt: "you> " });
rl.on("SIGINT", () => {
	output.write("\n");
	rl.close();
});

const lines = rl[Symbol.asyncIterator]();

output.write("bindu\n/exit or /quit to leave\n\n");

try {
	await runChat(
		{
			readLine: () => readChatLine(rl, lines),
			write: (text) => {
				output.write(text);
			},
		},
		{
			send: async (text, emit) => {
				let streamed = false;
				emitChunk = (chunk) => {
					streamed = true;
					emit(chunk);
				};
				try {
					const result = await agent.sessions.prompt({
						content: [{ type: "text", text }],
					});
					if (streamed) return streamedStopSuffix(result.stopReason);
					return formatTurn(result.message?.content ?? [], result.stopReason);
				} finally {
					emitChunk = null;
				}
			},
		},
	);
} finally {
	rl.close();
	await conn.dispose();
}

import * as assert from "node:assert/strict";
import * as readline from "node:readline/promises";
import { PassThrough, Readable, Writable } from "node:stream";
import { describe, it } from "node:test";
import {
	formatAgentMessage,
	formatTurn,
	isExitCommand,
	messageChunkText,
	readChatLine,
	runChat,
	streamedStopSuffix,
	type AgentTurn,
	type ChatIo,
} from "./chat-loop";

function scriptedIo(lines: Array<string | null>): ChatIo & { written: string[] } {
	const pending = [...lines];
	const written: string[] = [];
	return {
		written,
		readLine: async () => (pending.length > 0 ? pending.shift()! : null),
		write: (text) => {
			written.push(text);
		},
	};
}

describe("isExitCommand", () => {
	it("accepts /exit and /quit", () => {
		assert.equal(isExitCommand("/exit"), true);
		assert.equal(isExitCommand("  /quit  "), true);
		assert.equal(isExitCommand("/EXIT"), true);
	});

	it("leaves ordinary messages alone", () => {
		assert.equal(isExitCommand("exit"), false);
		assert.equal(isExitCommand("please /exit later"), false);
		assert.equal(isExitCommand(""), false);
	});
});

describe("formatAgentMessage", () => {
	it("concatenates text chunks and skips everything else", () => {
		assert.equal(
			formatAgentMessage([
				{ type: "text", text: "Hi" },
				{ type: "text", text: "! I'm" },
				{ type: "image" },
				{ type: "text", text: " well.\n\nNext paragraph." },
			]),
			"Hi! I'm well.\n\nNext paragraph.",
		);
	});

	it("uses a placeholder when there is no text", () => {
		assert.equal(formatAgentMessage([]), "(no reply)");
		assert.equal(formatAgentMessage([{ type: "image" }]), "(no reply)");
		assert.equal(formatAgentMessage([{ type: "text", text: "  " }]), "(no reply)");
	});
});

describe("formatTurn", () => {
	it("hides a normal end of turn", () => {
		assert.equal(
			formatTurn([{ type: "text", text: "done" }], "end_turn"),
			"done",
		);
	});

	it("surfaces other stop reasons", () => {
		assert.equal(
			formatTurn([{ type: "text", text: "cut" }], "max_tokens"),
			"cut\n(max_tokens)",
		);
	});
});

describe("messageChunkText", () => {
	it("returns live text chunks", () => {
		assert.equal(
			messageChunkText({
				durability: "ephemeral",
				type: "agent_message_chunk",
				content: { type: "text", text: "Hel" },
			}),
			"Hel",
		);
	});

	it("ignores anything that is not a live text chunk", () => {
		assert.equal(messageChunkText(null), null);
		assert.equal(messageChunkText("hello"), null);
		assert.equal(
			messageChunkText({
				durability: "durable",
				type: "agent_message_chunk",
				content: { type: "text", text: "Hel" },
			}),
			null,
		);
		assert.equal(
			messageChunkText({
				durability: "ephemeral",
				type: "agent_thought_chunk",
				content: { type: "text", text: "thinking" },
			}),
			null,
		);
		assert.equal(
			messageChunkText({
				durability: "ephemeral",
				type: "agent_message_chunk",
				content: { type: "image" },
			}),
			null,
		);
	});
});

describe("streamedStopSuffix", () => {
	it("notes only an abnormal stop", () => {
		assert.equal(streamedStopSuffix("end_turn"), "");
		assert.equal(streamedStopSuffix("max_tokens"), "\n(max_tokens)");
	});
});

describe("runChat", () => {
	it("sends each turn in order on the same conversation", async () => {
		const sent: string[] = [];
		let inFlight = false;
		const agent: AgentTurn = {
			send: async (text) => {
				assert.equal(inFlight, false);
				inFlight = true;
				sent.push(text);
				await Promise.resolve();
				inFlight = false;
				return `echo:${text}`;
			},
		};
		const io = scriptedIo([" hello ", "", "again", "/exit", "ignored"]);

		await runChat(io, agent);

		assert.deepEqual(sent, ["hello", "again"]);
		assert.deepEqual(io.written, ["agent> echo:hello\n\n", "agent> echo:again\n\n"]);
	});

	it("stops on /quit and on end of input", async () => {
		const sent: string[] = [];
		const agent: AgentTurn = {
			send: async (text) => {
				sent.push(text);
				return text;
			},
		};

		await runChat(scriptedIo(["/quit"]), agent);
		await runChat(scriptedIo(["hi", null, "after"]), agent);

		assert.deepEqual(sent, ["hi"]);
	});

	it("prints a prompt error and keeps the conversation going", async () => {
		const agent: AgentTurn = {
			send: async (text) => {
				if (text === "boom") throw new Error("network down");
				return "ok";
			},
		};
		const io = scriptedIo(["boom", "next", "/exit"]);

		await runChat(io, agent);

		assert.deepEqual(io.written, ["error: network down\n\n", "agent> ok\n\n"]);
	});

	it("writes chunks as they arrive without repeating the reply", async () => {
		const agent: AgentTurn = {
			send: async (_text, emit) => {
				emit("Hel");
				emit("lo");
				return "";
			},
		};
		const io = scriptedIo(["hi", "/exit"]);

		await runChat(io, agent);

		assert.deepEqual(io.written, ["agent> ", "Hel", "lo", "\n\n"]);
	});

	it("breaks the line when a streamed turn fails", async () => {
		const agent: AgentTurn = {
			send: async (_text, emit) => {
				emit("Hel");
				throw new Error("network down");
			},
		};
		const io = scriptedIo(["hi", "/exit"]);

		await runChat(io, agent);

		assert.deepEqual(io.written, ["agent> ", "Hel", "\n", "error: network down\n\n"]);
	});
});

describe("readChatLine", () => {
	it("reads lines still buffered after stdin closes", async () => {
		const input = Readable.from(["hello\n/exit\n"]);
		const output = new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		});
		const rl = readline.createInterface({ input, output, prompt: "you> " });
		const lines = rl[Symbol.asyncIterator]();

		try {
			assert.equal(await readChatLine(rl, lines), "hello");
			assert.equal(await readChatLine(rl, lines), "/exit");
			assert.equal(await readChatLine(rl, lines), null);
		} finally {
			rl.close();
		}
	});

	it("prompts again while the terminal stays open", async () => {
		const input = new PassThrough();
		const shown: string[] = [];
		const output = new Writable({
			write(chunk, _encoding, callback) {
				shown.push(String(chunk));
				callback();
			},
		});
		const rl = readline.createInterface({ input, output, prompt: "you> " });
		const lines = rl[Symbol.asyncIterator]();

		try {
			const first = readChatLine(rl, lines);
			input.write("hello\n");
			assert.equal(await first, "hello");

			const second = readChatLine(rl, lines);
			input.write("again\n");
			assert.equal(await second, "again");
			assert.equal(shown.filter((chunk) => chunk.includes("you> ")).length, 2);
		} finally {
			rl.close();
		}
	});

	it("ends the turn when the interface closes", async () => {
		const input = new PassThrough();
		const output = new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		});
		const rl = readline.createInterface({ input, output, prompt: "you> " });
		const lines = rl[Symbol.asyncIterator]();
		const pending = readChatLine(rl, lines);
		rl.close();
		assert.equal(await pending, null);
	});
});

import { describe, expect, it } from "vitest";
import { replayFetch, runScenarios, type FixtureFile } from "./fixture-scenarios.ts";
import ollama15 from "./fixtures/ollama-qwen2.5-1.5b-instruct.json";
import ollama7 from "./fixtures/ollama-qwen2.5-7b-instruct.json";
import vllm15 from "./fixtures/vllm-Qwen-Qwen2.5-1.5B-Instruct.json";
import sglang15 from "./fixtures/sglang-Qwen-Qwen2.5-1.5B-Instruct.json";
import syntheticDialect from "./fixtures/synthetic-dialect.json";
import { OpenAiCompatibleProvider } from "./openai.ts";

// The adapter against the HTTP exchanges recorded from real local servers (F4 M3, T-120): Ollama, vLLM and SGLang, each with a model, saved by tools/scripts/record-http-fixtures.mjs: the method, the path, the body
// of every request and the status and body of every answer, never a header or a key, the address a placeholder. A `synthetic` fixture, written by hand in the dialect's shape, stands for a server that could not be
// recorded. The scenarios (model list, plain, structured, tool round trip, usage, wrong model) run through the adapter with a fetch that answers from the recording: no network. If the adapter's request changes,
// the recording no longer holds it and the test says which request.

// Each recording is listed here when it is added (the recorder prints the file it wrote).
const FIXTURES: readonly (readonly [string, FixtureFile])[] = [
  ["ollama-qwen2.5-1.5b-instruct.json", ollama15 as unknown as FixtureFile],
  ["ollama-qwen2.5-7b-instruct.json", ollama7 as unknown as FixtureFile],
  ["vllm-Qwen-Qwen2.5-1.5B-Instruct.json", vllm15 as unknown as FixtureFile],
  ["sglang-Qwen-Qwen2.5-1.5B-Instruct.json", sglang15 as unknown as FixtureFile],
  ["synthetic-dialect.json", syntheticDialect as unknown as FixtureFile],
];

describe("the recorded HTTP exchanges", () => {
  it("there is at least the synthetic one", () => {
    expect(FIXTURES.length).toBeGreaterThan(0);
  });

  for (const [f, fx] of FIXTURES) {
    describe(`${f} (${fx.server}, ${fx.model})`, () => {
      it("holds no header, key or address of a machine: only localhost placeholders and bodies", () => {
        const text = JSON.stringify(fx);
        expect(text).not.toMatch(/authorization|bearer|api[-_]?key/i);
        expect(text).not.toMatch(/https?:\/\/(?!localhost|127\.0\.0\.1)[a-z0-9.-]+/i);
        expect(text).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\/|\/root\//); // no path of a machine
        for (const e of fx.exchanges) expect(e.request.path).toMatch(/^\/v1\/(models|chat\/completions)$/);
      });

      it("gives, through the adapter and a fetch that answers from the recording, what the recording says the server did", async () => {
        const seen: string[] = [];
        const fetch = replayFetch(fx.exchanges, seen);
        const result = await runScenarios((o) => new OpenAiCompatibleProvider({ baseUrl: "http://localhost:0", fetch, structuredOutput: o.structuredOutput }), fx.model);
        expect(result).toEqual(fx.summary);
        // Every request the scenarios made was in the recording (the replay fails otherwise), and only the two paths of the dialect were used.
        expect(new Set(seen.map((s) => s.split(" ")[1]))).toEqual(new Set(["/v1/models", "/v1/chat/completions"]));
      });
    });
  }
});

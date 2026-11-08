// Records the HTTP exchanges of a real OpenAI-compatible server for the adapter's fixtures (F4 M3, T-120).
//
//   node tools/scripts/record-http-fixtures.mjs <server> <baseUrl> <model> [version]
//   node tools/scripts/record-http-fixtures.mjs ollama http://localhost:11434 qwen2.5:1.5b-instruct 0.12.3
//
// It runs the scenarios of packages/minds/src/fixture-scenarios.ts through the adapter against the server and writes packages/minds/src/fixtures/<server>-<model>.json: the method, the path, the body of each
// request and the status and body of each answer. No header is recorded; the address is a placeholder; no key is read or sent (a server that needs one is not recorded by this script). Run it by hand: it calls the
// server you name, on this machine, and nothing else.

import { mkdirSync, writeFileSync } from "node:fs";
import { OpenAiCompatibleProvider } from "../../packages/minds/src/openai.ts";
import { recordingFetch, runScenarios } from "../../packages/minds/src/fixture-scenarios.ts";

const [server, baseUrl, model, version = "unknown"] = process.argv.slice(2);
if (!server || !baseUrl || !model) {
  console.error("usage: node tools/scripts/record-http-fixtures.mjs <server> <baseUrl> <model> [version]");
  process.exit(2);
}
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseUrl)) {
  console.error("only a server on this machine is recorded (http://localhost:PORT or http://127.0.0.1:PORT)");
  process.exit(2);
}

const exchanges = [];
const realFetch = (url, init) => fetch(url, init);
const placeholder = "http://localhost:0";
// The adapter calls the placeholder; the recorder sends each call to the real server.
const toServer = (url, init) => realFetch(url.replace(placeholder, baseUrl), init);
const make = ({ structuredOutput }) => new OpenAiCompatibleProvider({ baseUrl: placeholder, fetch: recordingFetch(toServer, placeholder, exchanges), structuredOutput });
const summary = await runScenarios(make, model);
const file = `packages/minds/src/fixtures/${server}-${model.replace(/[^a-z0-9.]+/gi, "-")}.json`;
mkdirSync("packages/minds/src/fixtures", { recursive: true });
writeFileSync(file, `${JSON.stringify({ server, version, model, summary, exchanges }, null, 2)}\n`);
console.log(`${file}\n${JSON.stringify(summary, null, 2)}`);

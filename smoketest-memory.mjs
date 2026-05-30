// End-to-end smoke test for the memory connector via the JSON-RPC stdio
// transport. Drives the connector exactly like OpenCode would.
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

const dbDir = mkdtempSync(join(tmpdir(), "memory-smoketest-"));
const dbPath = join(dbDir, "test.db");

const child = spawn("node", ["./connectors/memory/dist/index.js"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, MEMORY_DB_PATH: dbPath },
});

let buf = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function callTool(name, args) {
  const res = await rpc("tools/call", { name, arguments: args });
  if (res.error) throw new Error(name + ": " + JSON.stringify(res.error));
  return JSON.parse(res.result.content[0].text);
}

try {
  // Init handshake.
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoketest", version: "0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const tools = await rpc("tools/list", {});
  console.log("tools:", tools.result.tools.map((t) => t.name).join(", "));

  console.log("\n--- remember 3 facts ---");
  console.log(await callTool("remember", { content: "Yura loves green tea", tags: ["preference"] }));
  console.log(await callTool("remember", { content: "Yura is working on the opencode-connectors project", tags: ["project"], importance: 5 }));
  console.log(await callTool("remember", { content: "Moscow gets as cold as -20 degrees Celsius in winter", tags: ["fact"] }));

  console.log("\n--- count ---");
  console.log(await callTool("count", {}));

  console.log("\n--- recall: 'what does Yura drink?' ---");
  const r1 = await callTool("recall", { query: "what does Yura drink?", min_similarity: 0 });
  console.log(JSON.stringify(r1, null, 2));
  if (!r1.results[0] || !r1.results[0].content.toLowerCase().includes("tea")) {
    throw new Error("Semantic recall failed — expected tea memory at top");
  }

  console.log("\n--- recall: 'weather and climate' ---");
  const r2 = await callTool("recall", { query: "weather and climate", min_similarity: 0 });
  console.log(JSON.stringify(r2, null, 2));
  if (!r2.results[0] || !r2.results[0].content.includes("-20")) {
    throw new Error("Semantic recall failed — expected weather memory at top");
  }

  console.log("\n--- search_by_tag: project ---");
  const r3 = await callTool("search_by_tag", { tag: "project" });
  console.log(JSON.stringify(r3, null, 2));
  if (r3.memories.length !== 1) throw new Error("Tag search failed");

  console.log("\n--- list_recent ---");
  const r4 = await callTool("list_recent", { n: 5 });
  console.log("recent count:", r4.memories.length);

  console.log("\n--- update ---");
  const id = r4.memories[0].id;
  console.log(await callTool("update", { id, importance: 1 }));

  console.log("\n--- get ---");
  console.log(await callTool("get", { id }));

  console.log("\n--- forget + count ---");
  console.log(await callTool("forget", { id }));
  console.log(await callTool("count", {}));

  console.log("\n--- log_action: file-edit ---");
  const la1 = await callTool("log_action", {
    type: "file-edit",
    target: "src/foo.ts",
    summary: "added dark-mode toggle to Settings",
  });
  console.log(la1);
  if (!la1.tags.includes("action") || !la1.tags.includes("action:file-edit") || !la1.tags.includes("target:src/foo.ts")) {
    throw new Error("log_action did not produce expected auto-tags");
  }

  console.log("\n--- log_action: pr ---");
  console.log(await callTool("log_action", { type: "pr", target: "#42", summary: "opened PR for dark mode", importance: 4 }));

  console.log("\n--- search_by_tag: target:src/foo.ts (file history) ---");
  const fh = await callTool("search_by_tag", { tag: "target:src/foo.ts" });
  console.log(JSON.stringify(fh, null, 2));
  if (fh.memories.length !== 1) throw new Error("File-history tag search failed");

  console.log("\n--- export_all ---");
  const dump = await callTool("export_all", {});
  console.log("exported", dump.memories.length, "memories");

  console.log("\nALL SMOKE TESTS PASSED");
  child.kill();
  process.exit(0);
} catch (e) {
  console.error("\nSMOKE TEST FAILED:", e.message);
  child.kill();
  process.exit(1);
}

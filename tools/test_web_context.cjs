// Generated fixtures only. No model server, saved conversations or browser profile.
const assert = require("node:assert/strict");
const test = require("node:test");
const {prepare} = require("../serve/web/context.js");

function history(turns = 20, size = 1000) {
  const list = [];
  for (let i = 0; i < turns; i++) {
    list.push({role: "user", content: `Synthetic ${i}: 모임은 달빛 도서관, 18:40. ` + "가😀".repeat(size)});
    list.push({role: "assistant", content: "Synthetic acknowledgement. " + "나".repeat(300)});
  }
  list.push({role: "user", content: "자체 시험: 약속을 알려 주세요."});
  return list;
}
function harness(extra = {}) {
  const calls = [], commits = [];
  return {calls, commits, model: "synthetic", maxContext: 4096,
    onCommit: (s) => commits.push(s),
    post: async (path, body) => {
      calls.push({path, body});
      if (path.endsWith("count_tokens")) return {input_tokens: Math.ceil(JSON.stringify(body.messages).length / 2)};
      assert.equal(path, "v1/chat/completions");
      assert.equal(body.strata_mcp, false);
      assert.equal(body.tool_choice, "none");
      assert.equal(body.reasoning_effort, "none");
      assert.equal(body.strata_checkpoint, false);
      assert.ok(body.messages.every((m) => m.content.isWellFormed()), "do not split surrogate pairs");
      return {choices: [{finish_reason: "stop", message: {content: "자체 생성 요약: 모임은 달빛 도서관, 18:40."}}]};
    }, ...extra};
}
const generated = (h) => h.calls.filter((c) => !c.path.endsWith("count_tokens"));

test("short chat counts without generating a summary", async () => {
  const h = harness(), list = [{role: "user", content: "안녕"}];
  const r = await prepare({...h, messages: list});
  assert.equal(r.summarized, false);
  assert.deepEqual(r.messages, list);
  assert.equal(generated(h).length, 0);
});
for (const context of [4096, 16384, 65536]) test(`chunking and response headroom at ${context}`, async () => {
  const h = harness({maxContext: context}), list = history(50, 1200), before = JSON.stringify(list);
  const r = await prepare({...h, messages: list});
  assert.equal(r.summarized, true);
  assert.equal(h.commits.length, 1);
  assert.ok(generated(h).length > 1);
  assert.equal(list[r.state.covered].role, "user");
  assert.equal(r.messages.at(-1), list.at(-1));
  assert.ok(r.inputTokens + r.maxTokens + Math.min(2048, context / 16) <= context);
  for (const c of generated(h)) assert.ok(Math.ceil(JSON.stringify(c.body.messages).length / 2) + c.body.max_tokens <= context);
  assert.equal(JSON.stringify(list), before);
  const reuse = harness({maxContext: context});
  assert.equal((await prepare({...reuse, messages: list, state: r.state})).summarized, false);
  assert.equal(generated(reuse).length, 0);
});
test("tool call/result groups stay inside a complete turn", async () => {
  const list = history();
  list.splice(list.length - 2, 1,
    {role: "assistant", content: "", tool_calls: [{id: "synthetic-call", type: "function", function: {name: "lookup", arguments: "{}"}}]},
    {role: "tool", tool_call_id: "synthetic-call", content: "Synthetic result"},
    {role: "assistant", content: "Synthetic answer"});
  const r = await prepare({...harness(), messages: list});
  assert.equal(list[r.state.covered].role, "user");
  const call = r.messages.findIndex((m) => m.tool_calls);
  assert.ok(call > 0);
  assert.equal(r.messages[call + 1].tool_call_id, "synthetic-call");
});
for (const failure of ["length", "empty", "abort", "network"]) test(`${failure} in a later chunk leaves previous memory untouched`, async () => {
  const h = harness(), post = h.post, list = history(), before = JSON.stringify(list);
  const state = {version: 1, covered: 2, summary: "Previous synthetic memory"};
  let n = 0;
  h.post = async (path, body) => {
    if (!path.endsWith("count_tokens") && ++n === 2) {
      if (failure === "abort") throw Object.assign(new Error("Stopped"), {name: "AbortError"});
      if (failure === "network") throw new Error("Synthetic connection failure");
      return {choices: [{finish_reason: failure === "length" ? "length" : "stop", message: {content: ""}}]};
    }
    return post(path, body);
  };
  await assert.rejects(prepare({...h, messages: list, state}));
  assert.equal(h.commits.length, 0);
  assert.deepEqual(state, {version: 1, covered: 2, summary: "Previous synthetic memory"});
  assert.equal(JSON.stringify(list), before);
});
test("oversized current input and edited summary fail without truncation", async () => {
  const h = harness();
  await assert.rejects(prepare({...h, messages: [{role: "user", content: "가".repeat(20000)}]}), /too large/);
  const list = [{role: "user", content: "Old"}, {role: "assistant", content: "Old"}, {role: "user", content: "New"}];
  await assert.rejects(prepare({...h, messages: list,
    state: {version: 1, covered: 2, summary: "a".repeat(20000)}}), /too large/);
  assert.equal(generated(h).length, 0);
});
test("bad state, invalid budgets and images are not silently discarded", async () => {
  const h = harness(), list = [{role: "user", content: "Synthetic"}];
  await assert.rejects(prepare({...h, messages: list, state: {version: 1, covered: 7, summary: "Invalid"}}), /does not match/);
  await assert.rejects(prepare({...h, messages: list, maxTokens: 4000}), /Reduce Max tokens/);
  await assert.rejects(prepare({...h, messages: list, maxTokens: -1}), /whole number/);
  await assert.rejects(prepare({...h, messages: list, maxContext: 0}), /context size/);
  await assert.rejects(prepare({...h, messages: [{role: "user", content: [{type: "image_url", image_url: {url: "https://invalid.example/image.png"}}]}]}), /text only/);
  assert.equal(h.calls.length, 0);
});
test("final size check and failed persistence prevent publishing the new summary", async () => {
  const h = harness(), post = h.post;
  h.post = (path, body) => path.endsWith("count_tokens") && body.messages[0]?.content?.startsWith("Reference summary") ?
    Promise.resolve({input_tokens: 10000}) : post(path, body);
  await assert.rejects(prepare({...h, messages: history()}), /still too large/);
  assert.equal(h.commits.length, 0);
  await assert.rejects(prepare({...harness(), messages: history(), onCommit() { throw new Error("Storage full"); }}), /Storage full/);
});

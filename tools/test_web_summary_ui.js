// Run with playwright-cli run-code --filename tools/test_web_summary_ui.js from the repository root.
// First export the base revision's serve/web/app.js to output/playwright/baseline-app.js.
// All traffic is fulfilled or rejected here. Never open the user's browser profile or real model server.
async (page) => {
  const root = "serve/web/";
  const origin = "http://strata-summary.test";
  const fixture = {errors: [], answers: [], counts: 0, blocked: 0, baseline: false, large: false, failSummary: false};
  const passed = [];
  const check = (condition, label) => { if (!condition) throw Error(label); passed.push(label); };
  page.on("pageerror", e => fixture.errors.push(e.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { fixture.blocked++; return route.abort(); }
    const files = ["index.html", "app.js", "context.js", "app.css", "components.css", "tokens.css", "sprite.svg", "favicon.svg"];
    const file = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/web\//, "");
    if (files.includes(file)) return route.fulfill({path: fixture.baseline && file === "app.js" ?
      "output/playwright/baseline-app.js" : root + file});
    if (url.pathname === "/fonts/outfit-latin-wght.woff2") return route.fulfill({path: root + "fonts/outfit-latin-wght.woff2"});
    const json = data => route.fulfill({contentType: "application/json", body: JSON.stringify(data)});
    if (url.pathname === "/health") return json({status: "ok", loaded: true, model: "synthetic-summary-test", max_context: 65536, images: false});
    if (url.pathname === "/metrics") return json({live: {state: "idle"}, requests: []});
    if (url.pathname === "/settings") return json({shared: false, defaults: {}});
    if (url.pathname === "/mcp") return json({servers: [], tools: 0});
    if (url.pathname === "/v1/chat/completions/count_tokens") {
      fixture.counts++;
      const body = route.request().postDataJSON();
      return json({input_tokens: fixture.large ? Math.ceil(JSON.stringify(body.messages).length / 2) : 200});
    }
    if (url.pathname === "/v1/chat/completions") {
      const body = route.request().postDataJSON();
      fixture.answers.push({body, raw: route.request().postData()});
      if (!body.stream) {
        if (fixture.failSummary) return route.abort("failed");
        return json({choices: [{finish_reason: "stop", message: {content: "자체 생성 요약: 달빛 도서관 모임, 18:40."}}]});
      }
      return route.fulfill({contentType: "text/event-stream", body: 'data: {"choices":[{"delta":{"content":"자체 생성 응답"}}]}\n\ndata: [DONE]\n\n'});
    }
    fixture.blocked++;
    return route.abort();
  });
  await page.goto(origin);
  const reset = async (chat, enabled = false, sampling = {thinking: "none", mcp: false}) => {
    await page.evaluate(({chat, enabled, sampling}) => {
      localStorage.clear();
      localStorage.setItem("strata.chat", JSON.stringify(chat));
      localStorage.setItem("strata.sampling", JSON.stringify(sampling));
      localStorage.setItem("strata.summaryEnabled", JSON.stringify(enabled));
    }, {chat, enabled, sampling});
    await page.reload();
    await page.waitForFunction(() => document.getElementById("chat-empty-sub").textContent.includes("synthetic-summary-test"));
  };
  const send = async (text = "자체 생성 후속 질문") => {
    await page.getByLabel("Message", {exact: true}).fill(text);
    await page.getByRole("button", {name: "Send", exact: true}).click();
    await page.waitForFunction(() => !document.getElementById("send-btn").disabled);
  };
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("strata.chat")));
  const open = () => page.locator("#memory-open").click();
  const box = page.getByLabel("Summary sent to the model", {exact: true});
  const save = () => page.getByRole("button", {name: "Save summary", exact: true}).click();
  const chat = [{role: "user", text: "자체 생성 원문: 장소는 달빛 도서관."},
    {role: "assistant", text: "자체 생성 과거 응답"},
    {role: "user", text: "자체 생성 최근 질문"}, {role: "assistant", text: "자체 생성 최근 응답"}];
  chat.forEach((m, i) => { m.time = Date.UTC(2026, 0, 1, 1, i); });

  // Use the original app.js from the branch's base commit, not a reimplementation of its request builder.
  for (const [name, sampling] of [["untouched", {}], ["thinking off", {thinking: "none", mcp: false}],
    ["custom sampling", {thinking: "low", temperature: 0.3, top_p: 0.7, top_k: 10, seed: "7", max: "250"}]]) {
    fixture.baseline = true;
    await reset(chat, false, sampling);
    await send();
    const baseline = fixture.answers.at(-1).raw;
    fixture.baseline = false;
    await reset(chat, false, sampling);
    fixture.answers = []; fixture.counts = 0;
    await send();
    check(fixture.answers.length === 1 && fixture.answers[0].raw === baseline && fixture.counts === 0,
      `${name}: opt-out request byte-identical to upstream, no count or summary calls`);
  }

  chat[0].contextMemory = {version: 1, covered: 2, summary: "자체 생성 요약: 모임은 10시."};
  await reset(chat, true);
  const initial = await stored();
  await open();
  check(await box.inputValue() === initial[0].contextMemory.summary, "view summary");
  await box.fill("취소할 자체 생성 편집");
  await page.getByRole("button", {name: "Cancel", exact: true}).click();
  check(JSON.stringify(await stored()) === JSON.stringify(initial), "cancel preserves storage");
  await open();
  await box.fill("   ");
  await save();
  check(await page.locator("#memory-error").isVisible() && JSON.stringify(await stored()) === JSON.stringify(initial), "blank edit rejected");
  const edited = "수정한 자체 요약: 모임은 11시. <script>window.bad=true</script>";
  await box.fill(edited);
  await page.evaluate(() => {
    window.fixtureSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function () { throw new DOMException("Synthetic quota failure", "QuotaExceededError"); };
  });
  await save();
  check((await page.locator("#memory-error").innerText()).includes("Could not save") && await box.inputValue() === edited,
    "quota failure retains draft");
  await page.getByRole("button", {name: "Cancel", exact: true}).click();
  await open();
  check(await box.inputValue() === initial[0].contextMemory.summary, "quota failure rolls back in-memory summary");
  await page.evaluate(() => { Storage.prototype.setItem = window.fixtureSetItem; });
  await box.fill(edited);
  await save();
  const saved = await stored();
  check(saved[0].contextMemory.summary === edited && saved[0].contextMemory.covered === 2, "save preserves boundary");
  check(saved.every((m, i) => m.text === initial[i].text), "editing preserves original messages");
  await page.reload();
  await open();
  check(await box.inputValue() === edited && !await page.evaluate(() => window.bad), "reload persists text without executing HTML");
  await page.evaluate(() => {
    const chat = JSON.parse(localStorage.getItem("strata.chat"));
    chat[0].contextMemory.summary = "Synthetic edit from a second tab";
    localStorage.setItem("strata.chat", JSON.stringify(chat));
  });
  await box.fill("Synthetic stale draft");
  await save();
  check((await page.locator("#memory-error").innerText()).includes("another tab") &&
    (await stored())[0].contextMemory.summary === "Synthetic edit from a second tab", "stale editor does not overwrite another tab");
  await page.evaluate((saved) => localStorage.setItem("strata.chat", JSON.stringify(saved)), saved);
  await box.fill(edited);
  await page.keyboard.press("Escape");
  fixture.answers = [];
  await send();
  check(fixture.answers.length === 1 && fixture.answers[0].body.messages[0].content.includes(edited), "next request uses edited summary");
  check(fixture.answers[0].body.max_tokens === 4096, "reply has reserved output budget");
  await page.getByRole("switch", {name: "Automatic summaries", exact: true}).click();
  fixture.answers = []; fixture.counts = 0;
  await send("자체 생성: 원문으로 재개");
  check(fixture.counts === 0 && fixture.answers[0].body.messages[0].content === chat[0].text, "off restores full history without a count request");
  await page.getByRole("button", {name: "New chat", exact: true}).click();
  await open();
  check(await box.inputValue() === "" && await box.getAttribute("readonly") !== null && await page.locator("#memory-save").isDisabled(), "new chat has no summary to edit");
  await page.keyboard.press("Escape");

  // Exercise automatic compaction through the real send path, using generated large text and a stub model.
  const large = [];
  for (let i = 0; i < 50; i++) large.push({role: "user", text: `자체 생성 ${i}: ` + "가".repeat(3000)}, {role: "assistant", text: "Synthetic reply"});
  fixture.large = true; fixture.answers = [];
  await reset(large, true);
  await send();
  check(fixture.answers.filter((x) => !x.body.stream).length > 1 && fixture.answers.at(-1).body.stream,
    "long synthetic history summarizes in chunks before sending");
  const compacted = await stored();
  check(compacted[0].contextMemory.covered > 0 && compacted.slice(0, large.length).every((m, i) => m.text === large[i].text),
    "automatic summary keeps original history");
  fixture.failSummary = true; fixture.answers = [];
  await reset(large, true);
  await send();
  check(fixture.answers.length === 1 && !fixture.answers[0].body.stream && !(await stored())[0].contextMemory,
    "failed summary stops final request without publishing memory");
  fixture.failSummary = false;
  await reset(large, true);
  await page.evaluate(() => { Storage.prototype.setItem = function () { throw new DOMException("Synthetic quota", "QuotaExceededError"); }; });
  fixture.answers = [];
  await send();
  check(fixture.answers.every((x) => !x.body.stream) && !(await stored())[0].contextMemory,
    "automatic summary storage failure prevents final request");
  await open();
  check(await box.inputValue() === "", "automatic summary storage failure rolls back memory");
  await page.keyboard.press("Escape");
  // Reload restores native Storage methods; reset only the synthetic origin.
  await page.reload();
  fixture.large = false;
  chat[0].contextMemory.summary = "자체 생성 예시\n\n• 장소: 달빛 도서관\n• 시간: 토요일 오전 11시\n• 준비물: 파란 공책\n\n확인할 사항: 참석 인원은 아직 정하지 않음.";
  await reset(chat, true);
  await page.setViewportSize({width: 1280, height: 900});
  await open();
  await page.screenshot({path: "output/playwright/summary-desktop.png"});
  await page.setViewportSize({width: 390, height: 844});
  const bounds = await page.locator("#memory-dialog").boundingBox();
  check(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 844, "mobile dialog fits viewport");
  await page.screenshot({path: "output/playwright/summary-mobile.png"});
  await page.keyboard.press("Escape");
  await page.setViewportSize({width: 1280, height: 900});
  await page.getByRole("button", {name: "Switch between light and dark"}).click();
  await open();
  await page.screenshot({path: "output/playwright/summary-dark.png"});
  check(fixture.errors.length === 0, "no page errors: " + fixture.errors.join(", "));
  check(fixture.blocked === 0, "all requests used the isolated synthetic origin");
  return {passed, count: passed.length, syntheticOnly: true, realServerContacted: false};
}

const { JSDOM } = require(process.env.NUI_JSDOM_MODULE || "jsdom");
const { build } = require("esbuild"),
  assert = require("node:assert/strict"),
  path = require("node:path");
(async () => {
  const dom = new JSDOM('<button id="anchor">menu</button><main></main>', {
      url: "https://test.example",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    }),
    w = dom.window;
  const bundle = async (entry, name) =>
    w.eval(
      (
        await build({
          entryPoints: [entry],
          bundle: true,
          write: false,
          format: "iife",
          globalName: name,
          plugins: [
            {
              name: "root",
              setup(b) {
                b.onResolve({ filter: /^\/assets\// }, (a) => ({
                  path: path.resolve("web" + a.path),
                }));
              },
            },
          ],
        })
      ).outputFiles[0].text,
    );
  await bundle("web/assets/js/core.js", "Core");
  await bundle("web/admin/calculator.js", "Calc");
  assert.equal(w.Calc.calculate("2+3*4"), "14");
  assert.equal(w.Calc.calculate("-(2+3)/2"), "-2.5");
  assert.equal(w.Calc.calculate(".1+.2"), "0.3");
  for (const text of ["alert(1)", "1/0", "2**2", "1..2", "(2", "1 2"])
    assert.throws(() => w.Calc.calculate(text));
  let clicked = 0;
  const anchor = w.document.querySelector("#anchor");
  w.Core.openMenu(
    anchor,
    [
      { label: "disabled", disabled: true },
      { label: "first", onClick: () => clicked++ },
      { label: "second" },
    ],
    { x: 100, y: 100 },
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(w.document.activeElement.textContent, "first");
  w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "End" }));
  assert.equal(w.document.activeElement.textContent, "second");
  w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Home" }));
  w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter" }));
  assert.equal(clicked, 1);
  assert.equal(w.document.activeElement, anchor);
  w.Core.closeOverlays();
  let xhr;
  w.XMLHttpRequest = class {
    constructor() {
      xhr = this;
      this.upload = {};
      this.headers = {};
    }
    open(...a) {
      this.opened = a;
    }
    setRequestHeader(k, v) {
      this.headers[k] = v;
    }
    send(blob) {
      this.blob = blob;
    }
    abort() {
      this.onabort();
    }
  };
  const p = [],
    controller = new w.AbortController(),
    upload = w.Core.uploadWithProgress(
      "/api/admin/appearance/assets/pet",
      new w.Blob(["data"]),
      (n) => p.push(n),
      { signal: controller.signal },
    );
  assert.equal(xhr.headers["X-Memo-Client"], "web");
  xhr.upload.onprogress({ lengthComputable: true, loaded: 2, total: 4 });
  assert.equal(p[0], 0.5);
  controller.abort();
  await assert.rejects(upload, (e) => e.name === "AbortError");
  w.fetch = async () => ({
    ok: true,
    headers: { get: () => "application/json" },
    json: async () => ({
      ok: true,
      appearance: { assets: {}, petSize: 120 },
      storageMode: "local",
    }),
  });
  w.Worker = class {
    postMessage() {
      this.onmessage({ data: { progress: 50 } });
      this.onmessage({
        data: {
          bytes: new ArrayBuffer(1),
          type: "image/gif",
          width: 1,
          height: 1,
          frames: 1,
        },
      });
    }
    terminate() {}
  };
  w.URL.createObjectURL = () => "blob:test";
  w.URL.revokeObjectURL = () => {};
  await bundle("web/admin/customize.js", "Customize");
  const page = w.document.querySelector("main"),
    cleanup = w.Customize.renderAppearance(page);
  await new Promise((r) => setTimeout(r, 10));
  Object.defineProperty(page.querySelector("input[type=file]"), "files", {
    value: [
      {
        size: 10,
        type: "image/gif",
        arrayBuffer: async () => new ArrayBuffer(10),
      },
    ],
  });
  const click = (t) =>
    [...page.querySelectorAll("button")]
      .find((b) => b.textContent === t)
      .click();
  click("本机压缩 / 抠图并预览");
  await new Promise((r) => setTimeout(r, 10));
  const uploadButton = [...page.querySelectorAll("button")].find(
    (b) => b.textContent === "确认预览并上传",
  );
  assert(uploadButton);
  uploadButton.click();
  xhr.upload.onprogress({ lengthComputable: true, loaded: 1, total: 4 });
  assert.equal(page.querySelector("progress").value, 0.25);
  assert(page.textContent.includes("25%"));
  xhr.upload.onload();
  assert(!page.querySelector("progress").hasAttribute("value"));
  assert(page.textContent.includes("正在写入存储"));
  click("取消上传");
  await new Promise((r) => setTimeout(r, 10));
  assert(page.textContent.includes("已取消上传"));
  assert(!uploadButton.disabled);
  uploadButton.click();
  cleanup();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(xhr.blob.size, 1);
  console.log(
    "PASS safe calculator arithmetic, accessible keyboard menu, XHR headers/real progress/server phase/cancel and disposal",
  );
  dom.window.close();
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

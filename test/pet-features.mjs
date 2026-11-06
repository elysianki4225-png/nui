import assert from "node:assert/strict";
export async function checkPetFeatures(admin, user, base) {
  await admin.setViewportSize({ width: 1440, height: 900 });
  await admin.goto(base + "/admin/");
  await admin.locator(".nav-rail-item").filter({ hasText: "主题" }).click();
  await admin.getByLabel('桌宠音频',{exact:true}).waitFor();
  for(const width of [320,360,768,1440]){await admin.setViewportSize({width,height:900});assert(await admin.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'audio editor must fit phone');}
  const wav = Buffer.alloc(44 + 48000 * 4 * 4);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(48000, 24);
  wav.writeUInt32LE(192000, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  await admin
    .getByLabel("桌宠音频", { exact: true })
    .setInputFiles({ name: "sound.wav", mimeType: "audio/wav", buffer: wav });
  await admin.getByRole("button", { name: "压缩并试听", exact: true }).click();
  await admin.getByRole("status").filter({ hasText: "处理完成" }).waitFor();
  assert.equal(
    await admin
      .getByLabel("桌宠音频试听")
      .evaluate((e) => e.src.startsWith("blob:")),
    true,
  );
  const upload = admin.waitForRequest(
    (r) =>
      r.url().includes("/api/admin/appearance/assets/sound") &&
      r.method() === "PUT",
  );
  await admin.getByRole("button", { name: "上传音频", exact: true }).click();
  await upload;
  await admin
    .getByRole("status")
    .filter({ hasText: "桌宠音频已保存" })
    .waitFor();
  assert(
    await admin.evaluate(
      async () =>
        (await (await fetch("/api/theme-assets/sound")).arrayBuffer())
          .byteLength < 192000,
    ),
  );
  await admin.evaluate(async () => {
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGYQAAAAASUVORK5CYII=",
      ),
      (c) => c.charCodeAt(0),
    );
    const r = await fetch("/api/admin/appearance/assets/desktop", {
      method: "PUT",
      headers: { "X-Memo-Client": "test" },
      body: png,
    });
    if (!r.ok) throw Error(await r.text());
  });
  await user.addInitScript(() => {
    window.petPlayCount = 0;
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      window.petPlayCount++;
      window.playingPetAudio = this;
      return original.call(this);
    };
  });
  await user.reload();
  await user.locator(".site-pet").waitFor();
  await user.locator(".site-pet").click();
  assert.equal(await user.evaluate(() => window.petPlayCount), 0);
  await user.setViewportSize({ width: 1440, height: 900 });
  await user.locator(".nav-rail-item").filter({ hasText: "设置" }).click();
  await user.getByLabel("显示管理员背景").uncheck();
  assert(
    !(await user.locator("#site-appearance").textContent()).includes(
      "background-image",
    ),
  );
  await user.getByLabel("显示管理员桌宠").uncheck();
  assert.equal(await user.locator(".site-pet").count(), 0);
  await user.reload();
  await user.locator(".nav-rail-item").filter({ hasText: "设置" }).click();
  assert.equal(await user.getByLabel("显示管理员桌宠").isChecked(), false);
  await user.getByLabel("显示管理员桌宠").check();
  await user.getByLabel("桌宠声音").check();
  for (const width of [320, 360, 768, 1440]) {
    await user.setViewportSize({ width, height: 780 });
    const p = await user.locator(".site-pet").boundingBox(),
      x = p.x + p.width / 2,
      y = p.y + p.height / 2;
    if (width < 600) {
      const cdp = await user.context().newCDPSession(user);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: width - 1, y: 779 }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await cdp.detach();
    } else {
      await user.mouse.move(x, y);
      await user.mouse.down();
      await user.mouse.move(width - 1, 779, { steps: 10 });
      await user.mouse.up();
    }
    const r = await user.locator(".site-pet").boundingBox();
    assert(
      r.x >= 0 && r.y >= 0 && r.x + r.width <= width && r.y + r.height <= 780,
      JSON.stringify(r),
    );
    assert.equal(
      await user.evaluate(() => window.petPlayCount || 0),
      0,
      "drag must not play",
    );
  }
  await user.locator(".site-pet").click();
  await user.waitForFunction(() => window.petPlayCount === 1);
  await user.locator(".site-pet").click();
  assert(await user.evaluate(() => window.playingPetAudio.paused));
  await user.getByLabel("桌宠声音").uncheck();
  assert(await user.evaluate(() => window.playingPetAudio.paused));
  await user.getByLabel("显示管理员背景").check();
  await user
    .locator(".nav-rail-item")
    .filter({ hasText: "备忘录", exact: true })
    .click();
  await user.setViewportSize({ width: 360, height: 780 });
  await user.getByTitle("新建备忘录", { exact: true }).click();
  await user.getByRole("button", { name: "创建文件夹", exact: true }).click();
  await user.getByLabel("文件夹名称").waitFor();
  await user
    .locator(".dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await user.locator(".dialog").waitFor({ state: "detached" });
  await user.getByTitle("新建备忘录", { exact: true }).click();
  const chooser = user.waitForEvent("filechooser");
  await user.getByRole("button", { name: "上传文件", exact: true }).click();
  const fc = await chooser;
  assert(fc.isMultiple());
  await fc.setFiles({
    name: "quick.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("quick upload"),
  });
  await user.getByText("quick.txt", { exact: true }).waitFor();
  await user
    .locator(".dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await user.locator(".dialog").waitFor({ state: "detached" });
  console.log(
    "PASS pet: real WAV compression/upload, default-muted click playback, no sound on mouse/touch drag, four-width bounds, persistent user opt-outs and mobile create/upload sheet",
  );
}

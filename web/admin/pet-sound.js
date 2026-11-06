import {
  h,
  uploadWithProgress,
  GET,
  API_BASE,
  DEL,
  formatBytes,
} from "/assets/js/core.js";
import { compressPetAudio } from "/assets/js/audio-process.js";
import { applyAppearance } from "/assets/js/appearance.js";
export function renderPetSound(page) {
  let alive = true,
    controller = null,
    blob = null,
    url = "",
    working = false;
  const input = h("input", {
      type: "file",
      accept: "audio/*",
      "aria-label": "桌宠音频",
    }),
    status = h("p", { role: "status" }),
    progress = h("progress", {
      max: 1,
      value: 0,
      hidden: true,
      class: "theme-progress",
    }),
    preview = h("audio", {
      controls: true,
      preload: "none",
      "aria-label": "桌宠音频试听",
    });
  function reset() {
    blob = null;
    save.disabled = true;
    if (preview.hasAttribute("src")) {
      preview.pause();
      preview.removeAttribute("src");
      preview.load();
    }
    if (url) URL.revokeObjectURL(url);
    url = "";
  }
  const process = h(
    "button",
    {
      class: "btn btn-tonal",
      onClick: async () => {
        if (working) return;
        if (!input.files[0]) {
          status.textContent = "请选择音频";
          return;
        }
        reset();
        working = true;
        controller = new AbortController();
        progress.hidden = false;
        progress.removeAttribute("value");
        status.textContent = "本机解码与降采样…";
        input.disabled = true;
        try {
          const result = await compressPetAudio(input.files[0], {
            signal: controller.signal,
            onProgress: (p) => {
              if (!alive) return;
              if (p !== null) progress.value = p;
            },
          });
          if (!alive) return;
          blob = result;
          url = URL.createObjectURL(blob);
          preview.src = url;
          save.disabled = false;
          status.textContent = `处理完成 ${formatBytes(blob.size)}，请试听后上传。单声道 16kHz，适合短音乐和音效。`;
        } catch (e) {
          if (alive) status.textContent = e.message;
        } finally {
          working = false;
          input.disabled = false;
          controller = null;
          progress.hidden = true;
        }
      },
    },
    "压缩并试听",
  );
  const save = h(
    "button",
    {
      class: "btn btn-filled",
      disabled: true,
      onClick: async () => {
        if (working || !blob) return;
        working = true;
        input.disabled = true;
        controller = new AbortController();
        progress.hidden = false;
        progress.value = 0;
        status.textContent = "正在上传…";
        try {
          const r = await uploadWithProgress(
            "/api/admin/appearance/assets/sound",
            blob,
            (p) => {
              if (!alive) return;
              if (p === null || p >= 1) {
                progress.removeAttribute("value");
                status.textContent = p === null ? "正在上传…" : "正在写入存储…";
              } else {
                progress.value = p;
                status.textContent = `上传 ${Math.round(p * 100)}%`;
              }
            },
            { signal: controller.signal },
          );
          if (alive) {
            applyAppearance(r.appearance, true);
            status.textContent =
              "桌宠音频已保存；用户开启声音后，点击桌宠播放或停止。";
          }
        } catch (e) {
          if (alive)
            status.textContent =
              e.name === "AbortError"
                ? "已取消；若传输已完成，服务器可能仍在保存，请刷新检查。"
                : e.message;
        } finally {
          working = false;
          input.disabled = false;
          controller = null;
          progress.hidden = true;
        }
      },
    },
    "上传音频",
  );
  input.addEventListener("change", () => {
    reset();
    status.textContent = "";
  });
  page.append(
    h(
      "section",
      { class: "panel" },
      h("h2", {}, "桌宠音乐 / 音效"),
      h(
        "p",
        { class: "muted" },
        "点击桌宠播放 / 停止，拖动不播放。原文件 ≤30MB、≤60 秒；本机统一压缩为单声道 16kHz WAV（≤2MB），不截断音乐；已有高压缩音频转换后可能变大。MP3、WAV 等以浏览器解码支持为准。",
      ),
      input,
      h(
        "div",
        { class: "row wrap gap-8" },
        process,
        save,
        h(
          "button",
          { class: "btn btn-outlined", onClick: () => controller?.abort() },
          "取消音频任务",
        ),
        h(
          "button",
          {
            class: "btn btn-outlined",
            onClick: async () => {
              if (working) return;
              working = true;
              try {
                const r = await DEL("/api/admin/appearance/assets/sound");
                if (alive) {
                  reset();
                  applyAppearance(r.appearance, true);
                  status.textContent = "音频已移除";
                }
              } catch (e) {
                if (alive) status.textContent = e.message;
              } finally {
                working = false;
              }
            },
          },
          "删除桌宠音频",
        ),
      ),
      progress,
      status,
      preview,
    ),
  );
  GET("/api/admin/appearance")
    .then((r) => {
      if (!alive || working || input.files.length) return;
      if (r.appearance.assets.sound) {
        preview.src = API_BASE + r.appearance.assets.sound;
        status.textContent = "已配置桌宠音频，可以试听或选择新文件替换。";
      }
    })
    .catch((e) => {
      if (alive && !working) status.textContent = e.message;
    });
  return () => {
    alive = false;
    controller?.abort();
    reset();
  };
}

import { h, GET, POST, PATCH, openDialog, toast } from "/assets/js/core.js";
export function renderMaintenance(page) {
  let alive = true,
    busy = false,
    latest = null,
    polling = false;
  const controller = new AbortController();
  const message = h("p", { class: "auth-note", role: "status" }),
    controls = h("div", { class: "row wrap gap-8" });
  const panel = h(
    "section",
    { class: "panel" },
    h("h2", {}, "系统维护"),
    h(
      "p",
      {},
      "更新只从本项目 main 拉取；先检查目标提交。维护时暂停写入，请先备份并保存工作。重启服务器会中断这台机器上的所有服务。",
    ),
    message,
    controls,
  );
  page.append(panel);
  const draw = async () => {
    if (!alive || polling) return;
    polling = true;
    try {
      const r = await GET("/api/admin/maintenance", {
        signal: controller.signal,
      });
      if (!alive) return;
      message.textContent =
        `当前 ${r.version} · ` +
        (r.available
          ? "维护服务已安装"
          : "维护服务未安装：请在 SSH 运行 sudo bash /opt/nui-memo/install.sh --update -y") +
        (latest ? `\nmain ${latest.version} · ${latest.sha}` : "") +
        (r.job ? `\n${r.job.action} · ${r.job.status} · ${r.job.message}` : "");
      for (const b of controls.querySelectorAll("[data-run]"))
        b.disabled =
          !r.available || busy || ["queued", "running"].includes(r.job?.status);
    } catch (e) {
      if (alive)
        message.textContent =
          "暂时无法连接。若正在重启请稍候；可通过 SSH 检查：" + e.message;
    } finally {
      polling = false;
    }
  };
  function action(kind, label) {
    return h(
      "button",
      {
        class:
          kind === "reboot-server"
            ? "btn btn-outlined danger"
            : "btn btn-outlined",
        "data-run": kind,
        disabled: true,
        onClick: () => {
          if (kind === "update" && !latest) return toast("请先检查更新");
          const password = h("input", {
            class: "tf-input",
            type: "password",
            autocomplete: "current-password",
            "aria-label": "维护认证密码",
            placeholder: "重新输入管理员密码",
          });
          const confirm = h("input", {
            class: "tf-input",
            "aria-label": "整机重启确认",
            placeholder: "输入：重启服务器",
          });
          const error = h("p", { role: "status", class: "auth-note" });
          let submitting = false;
          openDialog({
            title: label,
            content: h(
              "div",
              {},
              h(
                "p",
                {},
                kind === "update"
                  ? `目标 ${latest.version} · ${latest.sha}，检查失败会停止；请先备份。`
                  : kind === "reboot-server"
                    ? "所有服务将断开连接，请确认没有其他任务。"
                    : "仅重启备忘录后端，不重启整机。",
              ),
              password,
              kind === "reboot-server" ? confirm : null,
              error,
            ),
            actions: [
              { label: "取消" },
              {
                label: "确认执行",
                keepOpen: true,
                onClick: async (close) => {
                  if (submitting) return;
                  submitting = true;
                  busy = true;
                  try {
                    await POST("/api/admin/maintenance/run", {
                      action: kind,
                      password: password.value,
                      confirmation: confirm.value,
                      sha: latest?.sha,
                    });
                    password.value = "";
                    close();
                    message.textContent =
                      "请求已提交，等待维护服务执行。暂时断开不代表失败。";
                  } catch (e) {
                    password.value = "";
                    error.textContent = e.message;
                  } finally {
                    busy = false;
                    submitting = false;
                    void draw();
                  }
                },
              },
            ],
          });
        },
      },
      label,
    );
  }
  controls.append(
    h(
      "button",
      {
        class: "btn btn-filled",
        onClick: async (e) => {
          const b = e.currentTarget;
          b.disabled = true;
          try {
            latest = (await POST("/api/admin/maintenance/check")).latest;
            if (alive)
              message.textContent = `main 最新：${latest.version}\n提交：${latest.sha}\n点击“一键拉取更新”并重新认证后执行。`;
          } catch (e) {
            if (alive) message.textContent = e.message;
          } finally {
            b.disabled = false;
          }
        },
      },
      "检查更新",
    ),
    action("update", "一键拉取更新"),
    action("restart-service", "重启备忘录服务"),
    action("reboot-server", "重启服务器"),
  );
  void draw();
  const timer = setInterval(draw, 5000);
  const disguisePanel = h(
    "section",
    { class: "panel" },
    h("h2", {}, "管理员入口伪装"),
  );
  page.append(disguisePanel);
  GET("/api/admin/disguise")
    .then((c) => {
      if (!alive) return;
      const enabled = h("input", { type: "checkbox", checked: c.enabled });
      const code = h("input", {
        class: "tf-input",
        type: "password",
        inputmode: "numeric",
        maxLength: 12,
        autocomplete: "new-password",
        "aria-label": "计算器暗号",
        placeholder: c.hasCode
          ? "留空沿用已有暗号"
          : "6–12 位数字，建议至少 8 位",
      });
      const password = h("input", {
        class: "tf-input",
        type: "password",
        autocomplete: "current-password",
        "aria-label": "伪装设置认证密码",
        placeholder: "管理员密码",
      });
      const status = h("p", { role: "status", class: "auth-note" });
      disguisePanel.append(
        h(
          "label",
          { class: "row gap-8" },
          enabled,
          h("span", {}, "未登录时显示计算器"),
        ),
        h(
          "label",
          { class: "tf editor-field" },
          h("span", { class: "tf-field-label" }, "独立数字暗号"),
          code,
        ),
        h(
          "label",
          { class: "tf editor-field" },
          h("span", { class: "tf-field-label" }, "重新认证"),
          password,
        ),
        h(
          "p",
          {},
          "输入暗号后按等号进入正常登录；仍需管理员账号密码。暗号只保存哈希；错误尝试限流。伪装不是隐身防护，源码/接口仍可能被识别。忘记暗号可通过 SSH n-ui 重置管理员凭据，关闭伪装并使原会话失效。",
        ),
        h(
          "button",
          {
            class: "btn btn-filled",
            onClick: async (e) => {
              const b = e.currentTarget;
              b.disabled = true;
              try {
                await PATCH("/api/admin/disguise", {
                  enabled: enabled.checked,
                  code: code.value,
                  password: password.value,
                });
                code.value = "";
                status.textContent =
                  "已保存。退出管理员登录或使用无痕窗口测试。";
              } catch (e) {
                status.textContent = e.message;
              } finally {
                password.value = "";
                b.disabled = false;
              }
            },
          },
          "保存伪装设置",
        ),
        status,
      );
    })
    .catch((e) => {
      if (alive) disguisePanel.append(h("p", {}, e.message));
    });
  return () => {
    alive = false;
    controller.abort();
    clearInterval(timer);
  };
}

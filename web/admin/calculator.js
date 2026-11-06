import { h, clear, POST } from "/assets/js/core.js";
// Tiny arithmetic parser: no eval / Function and no execution of user input.
export function calculate(text) {
  if (!/^[\d.\s+*/()-]{1,100}$/.test(text)) throw Error("无效算式");
  const tokens = text.match(/\d+(?:\.\d*)?|\.\d+|[()+*/-]/g) || [];
  let i = 0;
  const atom = () => {
    const t = tokens[i++];
    if (t === "-") return -atom();
    if (t === "+") return atom();
    if (t === "(") {
      const n = sum();
      if (tokens[i++] !== ")") throw Error("括号不匹配");
      return n;
    }
    if (t === undefined || !/^\d|^\./.test(t)) throw Error("无效数字");
    return Number(t);
  };
  const product = () => {
    let n = atom();
    while (["*", "/"].includes(tokens[i])) {
      const op = tokens[i++],
        b = atom();
      n = op === "*" ? n * b : n / b;
    }
    return n;
  };
  const sum = () => {
    let n = product();
    while (["+", "-"].includes(tokens[i])) {
      const op = tokens[i++],
        b = product();
      n = op === "+" ? n + b : n - b;
    }
    return n;
  };
  const n = sum();
  if (i !== tokens.length || !Number.isFinite(n)) throw Error("无法计算");
  return String(Number(n.toPrecision(12)));
}
export function renderCalculator(app, onUnlocked) {
  clear(app);
  document.title = "计算器";
  let busy = false;
  const display = h("input", {
    class: "calc-display",
    value: "",
    inputmode: "decimal",
    maxLength: 100,
    "aria-label": "计算器输入",
    autocomplete: "off",
  });
  const note = h("p", { class: "muted", role: "status" }, "");
  async function equals() {
    if (busy) return;
    const value = display.value.trim();
    busy = true;
    try {
      if (/^\d{6,12}$/.test(value)) {
        try {
          await POST("/api/admin/disguise/unlock", { code: value });
          display.value = "";
          onUnlocked();
          return;
        } catch (e) {
          if (e.status === 429) {
            note.textContent = "请稍后再试";
            return;
          }
        }
      }
      display.value = calculate(value);
      note.textContent = "";
    } catch {
      note.textContent = "无法计算，请检查算式";
    } finally {
      busy = false;
    }
  }
  const keys = h("div", { class: "calc-keys" });
  for (const key of [
    "AC",
    "(",
    ")",
    "⌫",
    "7",
    "8",
    "9",
    "÷",
    "4",
    "5",
    "6",
    "×",
    "1",
    "2",
    "3",
    "−",
    "0",
    ".",
    "=",
    "+",
  ])
    keys.append(
      h(
        "button",
        {
          class: "calc-key",
          onClick: () => {
            if (busy) return;
            if (key === "AC") {
              display.value = "";
              note.textContent = "";
            } else if (key === "⌫") display.value = display.value.slice(0, -1);
            else if (key === "=") void equals();
            else if (display.value.length < 100)
              display.value += { "÷": "/", "×": "*", "−": "-" }[key] || key;
          },
        },
        key,
      ),
    );
  display.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void equals();
    }
    if (e.key === "Escape") {
      display.value = "";
      note.textContent = "";
    }
  });
  app.append(
    h(
      "main",
      { class: "calculator" },
      h("h1", {}, "计算器"),
      display,
      keys,
      note,
    ),
  );
}

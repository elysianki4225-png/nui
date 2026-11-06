import { toast } from "./core.js";
export function attachPet(pet, sound, enabled) {
  let drag = null,
    moved = false,
    audio = null,
    disposed = false,
    position = null;
  try {
    const p = JSON.parse(localStorage.getItem("memo-pet-position"));
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) position = p;
  } catch {}
  const viewport = () => {
    const v = window.visualViewport;
    return {
      x: v?.offsetLeft || 0,
      y: v?.offsetTop || 0,
      w: v?.width || innerWidth,
      h: v?.height || innerHeight,
    };
  };
  function place(x, y) {
    const v = viewport(),
      r = pet.getBoundingClientRect(),
      maxX = Math.max(8, v.w - r.width - 8),
      maxY = Math.max(8, v.h - r.height - 8);
    x = Math.max(8, Math.min(maxX, x - v.x));
    y = Math.max(8, Math.min(maxY, y - v.y));
    pet.style.left = `clamp(8px, ${x + v.x}px, calc(100vw - ${r.width}px - 8px))`;
    pet.style.top = `clamp(8px, ${y + v.y}px, calc(100dvh - ${r.height}px - 8px))`;
    pet.style.right = pet.style.bottom = "auto";
    position = { x: x / maxX, y: y / maxY };
  }
  function resize() {
    const v = viewport(),
      r = pet.getBoundingClientRect();
    if (position)
      place(
        v.x + position.x * Math.max(8, v.w - r.width - 8),
        v.y + position.y * Math.max(8, v.h - r.height - 8),
      );
    else place(r.left, r.top);
  }
  function down(e) {
    if (e.button !== 0 || drag) return;
    const r = pet.getBoundingClientRect();
    drag = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      left: r.left,
      top: r.top,
    };
    moved = false;
    try {
      pet.setPointerCapture(e.pointerId);
    } catch {
      drag = null;
    }
  }
  function move(e) {
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x,
      dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 5) moved = true;
    if (moved) {
      e.preventDefault();
      place(drag.left + dx, drag.top + dy);
    }
  }
  function up(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const id = drag.id;
    drag = null;
    try {
      pet.releasePointerCapture(id);
    } catch {}
    if (moved)
      try {
        localStorage.setItem("memo-pet-position", JSON.stringify(position));
      } catch {}
  }
  function cancel() {
    drag = null;
    moved = true;
  }
  async function play() {
    if (disposed || !enabled || !sound) return;
    if (audio && !audio.paused) {
      audio.pause();
      audio.currentTime = 0;
      return;
    }
    audio ||= new Audio(sound);
    audio.volume = 0.5;
    try {
      await audio.play();
    } catch {
      if (!disposed) toast("声音无法播放，请稍后重试");
    }
  }
  function click(e) {
    if (moved) {
      e.preventDefault();
      moved = false;
      return;
    }
    void play();
  }
  function key(e) {
    if (["Enter", " "].includes(e.key)) {
      e.preventDefault();
      void play();
    }
  }
  function visibility() {
    if (document.hidden) {
      audio?.pause();
      cancel();
    } else resize();
  }
  pet.draggable = false;
  pet.tabIndex = 0;
  pet.setAttribute("role", "button");
  pet.removeAttribute("aria-hidden");
  pet.setAttribute(
    "aria-label",
    enabled && sound
      ? "桌宠：拖动移动，点击播放或停止声音"
      : "桌宠：可拖动，声音在设置中开启",
  );
  const events = {
    pointerdown: down,
    pointermove: move,
    pointerup: up,
    pointercancel: cancel,
    lostpointercapture: () => {
      if (drag) cancel();
    },
    click,
    keydown: key,
    load: resize,
    dragstart: (e) => e.preventDefault(),
  };
  for (const [type, fn] of Object.entries(events))
    pet.addEventListener(type, fn);
  window.addEventListener("resize", resize);
  window.addEventListener("blur", cancel);
  window.visualViewport?.addEventListener("resize", resize);
  window.visualViewport?.addEventListener("scroll", resize);
  document.addEventListener("visibilitychange", visibility);
  resize();
  return () => {
    disposed = true;
    cancel();
    audio?.pause();
    if (audio) {
      audio.removeAttribute("src");
      audio.load();
      audio = null;
    }
    for (const [type, fn] of Object.entries(events))
      pet.removeEventListener(type, fn);
    window.removeEventListener("resize", resize);
    window.removeEventListener("blur", cancel);
    window.visualViewport?.removeEventListener("resize", resize);
    window.visualViewport?.removeEventListener("scroll", resize);
    document.removeEventListener("visibilitychange", visibility);
  };
}

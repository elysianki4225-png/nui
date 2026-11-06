import crypto from "node:crypto";
import { readJson, HttpError, parseCookies, setCookie } from "./util.js";
import { hashSecret, verifySecret } from "./security.js";
export function reauthenticate(
  req,
  body,
  { requireAdmin, store, limiter },
  ip,
) {
  const auth = requireAdmin(req);
  if (!limiter.allow(`admin-reauth:${ip}`, 5, 300))
    throw new HttpError(429, "重新认证过于频繁，请稍后再试", "RATE_LIMIT");
  if (
    typeof body.password !== "string" ||
    body.password.length > 128 ||
    !verifySecret(body.password, store.state.admin.passHash)
  )
    throw new HttpError(401, "管理员密码错误", "BAD_CREDENTIALS");
  return auth;
}
export class AdminDisguise {
  constructor(store) {
    this.store = store;
    this.key = crypto.randomBytes(32);
  }
  enabled() {
    return !!this.store.state.admin?.disguise?.enabled;
  }
  sign(value) {
    return crypto
      .createHmac("sha256", this.key)
      .update(value)
      .update(this.store.state.admin?.disguise?.codeHash || "")
      .digest("hex");
  }
  issue() {
    const expires = String(Math.floor(Date.now() / 1000) + 900);
    return expires + "." + this.sign(expires);
  }
  unlocked(req) {
    if (!this.enabled()) return true;
    const raw = parseCookies(req).memo_disguise || "";
    if (!/^\d{10}\.[a-f0-9]{64}$/.test(raw)) return false;
    const [expires, mac] = raw.split(".");
    if (+expires <= Date.now() / 1000 || +expires > Date.now() / 1000 + 901)
      return false;
    return crypto.timingSafeEqual(
      Buffer.from(mac),
      Buffer.from(this.sign(expires)),
    );
  }
}
export function registerDisguiseRoutes(
  { route, requireAdmin, cookieOpts },
  { store, limiter },
  disguise,
) {
  route("GET", "/api/admin/disguise", async (req) => {
    requireAdmin(req);
    return {
      ok: true,
      enabled: disguise.enabled(),
      hasCode: !!store.state.admin?.disguise?.codeHash,
    };
  });
  route("PATCH", "/api/admin/disguise", async (req, res, p, ip) => {
    requireAdmin(req);
    const b = await readJson(req, 4096);
    reauthenticate(req, b, { requireAdmin, store, limiter }, ip);
    if (typeof b.enabled !== "boolean")
      throw new HttpError(400, "请选择开启或关闭");
    const admin = store.state.admin;
    let codeHash = admin.disguise?.codeHash || "";
    if (b.enabled) {
      if (typeof b.code === "string" && b.code.length) {
        if (!/^\d{6,12}$/.test(b.code))
          throw new HttpError(400, "暗号需为 6–12 位数字，建议至少 8 位");
        codeHash = hashSecret(b.code);
      }
      if (!codeHash) throw new HttpError(400, "请设置计算器暗号");
    }
    store.log({
      t: "admin.set",
      admin: { ...admin, disguise: { enabled: b.enabled, codeHash } },
    });
    await store.flushDurable();
    store.audit(
      admin.username,
      "admin.disguise",
      b.enabled ? "开启计算器入口" : "关闭计算器入口",
    );
    return { ok: true, enabled: b.enabled };
  });
  route("POST", "/api/admin/disguise/unlock", async (req, res, p, ip) => {
    if (
      !limiter.allow(`disguise:${ip}`, 8, 600) ||
      !limiter.allow("disguise:global", 120, 600)
    )
      throw new HttpError(429, "尝试过于频繁，请稍后再试", "RATE_LIMIT");
    const b = await readJson(req, 1024),
      d = store.state.admin?.disguise;
    if (
      !d?.enabled ||
      typeof b.code !== "string" ||
      !/^\d{6,12}$/.test(b.code) ||
      !verifySecret(b.code, d.codeHash)
    )
      throw new HttpError(400, "输入无效", "BAD_CODE");
    setCookie(res, "memo_disguise", disguise.issue(), {
      ...cookieOpts(req),
      maxAge: 900,
    });
    return { ok: true };
  });
}

import { HttpError } from './util.js';
export function profileDTO(user) {
  return { nickname: user.nickname || '', bio: user.bio || '', avatar: user.avatar && user.nickname ? `/api/avatars/${encodeURIComponent(user.nickname)}` : '' };
}
export function validateProfile(body, users, account) {
  const nickname = String(body.nickname || '').normalize('NFKC').trim();
  const bio = String(body.bio || '').trim();
  if (!/^[\p{L}\p{N}_-]{2,24}$/u.test(nickname)) throw new HttpError(400, '网名需为 2–24 个文字、数字、下划线或短横线', 'BAD_NICKNAME');
  if (bio.length > 280) throw new HttpError(400, '简介最多 280 字', 'BAD_BIO');
  const nicknameKey = nickname.toLowerCase();
  if (Object.values(users).some(u => u.account !== account && u.nicknameKey === nicknameKey)) throw new HttpError(409, '该网名已被使用', 'NICKNAME_TAKEN');
  return { nickname, nicknameKey, bio };
}

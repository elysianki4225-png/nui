import {attachPet} from './pet.js';
import { API_BASE, GET } from './core.js';

let dispose = () => {},lastTheme=null,lastAdmin=false;
export function getAppearancePreferences(){let saved={};try{saved=JSON.parse(localStorage.getItem('memo-appearance-preferences'))||{};}catch{}return {background:saved.background!==false,pet:saved.pet!==false,sound:saved.sound===true};}
export function setAppearancePreference(key,value){if(!['background','pet','sound'].includes(key))return;const prefs=getAppearancePreferences();prefs[key]=!!value;localStorage.setItem('memo-appearance-preferences',JSON.stringify(prefs));if(lastTheme&&!lastAdmin)applyAppearance(lastTheme,false);}

function mix(hex, white, weight) {
  const n = parseInt(hex.slice(1), 16);
  return '#' + [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.round(v * weight + (white ? 255 : 0) * (1 - weight)).toString(16).padStart(2, '0')).join('');
}
function contrast(hex) {
  const n = parseInt(hex.slice(1), 16);
  const linear = [n >> 16, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722 > .179 ? '#000000' : '#ffffff';
}
export async function loadAppearance(admin = false) {
  try { const r = await GET('/api/appearance'); applyAppearance(r.appearance, admin); } catch { /* existing theme is safe if offline */ }
}
export function applyAppearance(theme, admin = false) {
  dispose();lastTheme=theme;lastAdmin=admin;
  const prefs=admin?{background:true,pet:true,sound:true}:getAppearancePreferences();
  theme={...theme,assets:{...theme.assets}};
  if(!prefs.background)for(const slot of ['desktop','tablet','mobile'])delete theme.assets[slot];
  if(!prefs.pet)theme.petEnabled=false;
  let disposePet=()=>{};
  const style = document.createElement('style'); style.id = 'site-appearance';
  const color = admin ? theme.adminColor : theme.userColor;
  let css = '';
  if (/^#[0-9a-f]{6}$/i.test(color || '')) {
    const light = mix(color, true, .15), dark = mix(color, false, .4), bright = mix(color, true, .55);
    css += `:root { --md-primary:${color}; --md-on-primary:${contrast(color)}; --md-primary-container:${light}; --md-on-primary-container:${contrast(light)}; --md-secondary-container:${light}; --md-on-secondary-container:${contrast(light)}; }
    :root[data-theme="dark"] { --md-primary:${bright}; --md-on-primary:${contrast(bright)}; --md-primary-container:${dark}; --md-on-primary-container:${contrast(dark)}; --md-secondary-container:${dark}; --md-on-secondary-container:${contrast(dark)}; }`;
  }
  const url = slot => theme.assets?.[slot] ? `url(${JSON.stringify(API_BASE + theme.assets[slot])})` : 'none';
  if (!admin && (theme.assets?.desktop || theme.assets?.tablet || theme.assets?.mobile)) {
    css += `body { background-image:${url('desktop')}; background-size:cover; background-position:center; background-attachment:fixed; }
    .shell, .user-app .main { background:transparent; } .shell .content, .auth-wrap { background:color-mix(in srgb,var(--md-surface) 80%,transparent); }
    @media(max-width:1023px) { body { background-image:${theme.assets?.tablet ? url('tablet') : url('desktop')}; } }
    @media(max-width:599px) { body { background-image:${theme.assets?.mobile ? url('mobile') : theme.assets?.tablet ? url('tablet') : url('desktop')}; } }`;
  }
  if(theme.assets?.logo) css += `.logo-badge, .drawer-logo, .site-logo { background-image:${url('logo')} !important; background-size:contain !important; background-position:center !important; background-repeat:no-repeat !important; } .logo-badge > svg, .drawer-logo > svg, .site-logo > svg { visibility:hidden; }`;
  style.textContent = css; document.head.append(style);
  const favicon=document.querySelector('link[rel="icon"]');
  const oldIcon=favicon?.getAttribute('href');
  if(favicon && theme.assets?.logo)favicon.setAttribute('href',API_BASE+theme.assets.logo);
  let pet = null;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const update = () => {
    if (!pet) return;
    const active = !document.hidden && !reduced.matches;
    if (active && !pet.hasAttribute('src')) pet.src = API_BASE + theme.assets.pet;
    if (!active) pet.removeAttribute('src');
    pet.hidden = !active;
  };
  if (theme.petEnabled && theme.assets?.pet && (!admin || theme.petOnAdmin)) {
    pet = document.createElement('img'); pet.className = 'site-pet'; pet.alt = ''; pet.setAttribute('aria-hidden', 'true');
    pet.style.setProperty('--pet-size', Math.max(48, Math.min(240, theme.petSize || 120)) + 'px');
    document.body.append(pet); update();disposePet=attachPet(pet,theme.assets.sound?API_BASE+theme.assets.sound:null,prefs.sound);
    document.addEventListener('visibilitychange', update); reduced.addEventListener('change', update);
  }
  dispose = () => { disposePet();if(favicon && oldIcon!=null)favicon.setAttribute('href',oldIcon); style.remove(); if (pet) { pet.removeAttribute('src'); pet.remove(); } document.removeEventListener('visibilitychange', update); reduced.removeEventListener('change', update); };
}

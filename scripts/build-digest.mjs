#!/usr/bin/env node
// Builds the weekly email digest from data/gigs.json: favourite-band gigs
// coming up, what was added in the last 7 days, and ticket sales opening in
// the next 7 days. Writes digest.html + digest-subject.txt for the
// weekly-digest workflow to send. No network access needed.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(path.join(ROOT, 'data', 'gigs.json'), 'utf8'));
const favourites = JSON.parse(readFileSync(path.join(ROOT, 'config', 'favourites.json'), 'utf8')).bands;

const SITE_URL = process.env.SITE_URL || 'https://tomi-sormunen.github.io/gig-tracker/';
const MAX_ROWS = 15;

const norm = (s) =>
  (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const favSet = new Set(favourites.map(norm));
const isFav = (g) => g.bands.some((b) => favSet.has(norm(b)));
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const now = Date.now();
const DAY = 86400_000;
const today = new Date(now).toISOString().slice(0, 10);
const fmt = (iso) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtDT = (iso) =>
  new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Helsinki' });

const upcoming = data.gigs.filter((g) => g.date >= today);

const favSoon = upcoming
  .filter((g) => isFav(g) && new Date(`${g.date}T12:00:00`) - now <= 30 * DAY)
  .sort((a, b) => a.date.localeCompare(b.date));
const added = upcoming
  .filter((g) => now - new Date(g.firstSeen) <= 7 * DAY)
  .sort((a, b) => (isFav(b) ? 1 : 0) - (isFav(a) ? 1 : 0) || a.date.localeCompare(b.date));
const onSale = upcoming
  .filter((g) => g.onSaleDate && new Date(g.onSaleDate) > now && new Date(g.onSaleDate) - now <= 7 * DAY)
  .sort((a, b) => new Date(a.onSaleDate) - new Date(b.onSaleDate));

const row = (g, extra = '') => `
  <tr>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;">
      ${isFav(g) ? '🤘 ' : ''}<a href="${esc(g.url || SITE_URL)}" style="color:#c0392b;font-weight:bold;text-decoration:none;">${esc(g.title)}</a><br>
      <span style="color:#666;font-size:13px;">${esc([g.venue, g.city, g.country].filter(Boolean).join(', '))} · ${fmt(g.date)}${extra}</span>
    </td>
  </tr>`;

const section = (title, gigs, extraFn = () => '') =>
  gigs.length
    ? `<h2 style="font-size:16px;margin:24px 0 8px;color:#111;">${title} (${gigs.length})</h2>
       <table style="border-collapse:collapse;width:100%;">${gigs.slice(0, MAX_ROWS).map((g) => row(g, extraFn(g))).join('')}</table>
       ${gigs.length > MAX_ROWS ? `<p style="color:#666;font-size:13px;">…and ${gigs.length - MAX_ROWS} more on the site.</p>` : ''}`
    : '';

const html = `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#222;">
  <h1 style="font-size:20px;letter-spacing:2px;">⚡ GIG TRACKER — weekly digest</h1>
  <p style="color:#666;font-size:13px;">${data.gigs.length} tracked gigs · data updated ${fmtDT(data.updatedAt)} · <a href="${SITE_URL}" style="color:#c0392b;">open the tracker</a></p>
  ${section('🎟️ Tickets on sale this week — be quick', onSale, (g) => ` · <b>on sale ${fmtDT(g.onSaleDate)}</b>`)}
  ${section('🤘 Your favourites playing in the next 30 days', favSoon)}
  ${section('🆕 Added in the last 7 days', added)}
  ${!onSale.length && !favSoon.length && !added.length ? '<p>All quiet this week — nothing new tracked. 🦗</p>' : ''}
  <p style="color:#999;font-size:12px;margin-top:28px;">Sent every Monday by the gig-tracker GitHub Action.</p>
</div>`;

const subject = `🤘 Gig Tracker weekly: ${onSale.length} sales opening, ${favSoon.length} favourite shows, ${added.length} new`;

writeFileSync(path.join(ROOT, 'digest.html'), html);
writeFileSync(path.join(ROOT, 'digest-subject.txt'), subject + '\n');
console.log(`Digest built: ${subject}`);

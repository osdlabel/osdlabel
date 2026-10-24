#!/usr/bin/env node
/* global window */
/**
 * Which styling mechanisms survive a strict `style-src 'self'` CSP (no
 * 'unsafe-inline')? Inline styles set through the CSSOM are what the stock UI
 * used; the stylesheet prototype adopts a constructed CSSStyleSheet, with a
 * `<style>` fallback where constructable sheets are missing.
 *
 *   node scripts/csp-probe.mjs [--chromium <path>]
 */
import { chromium } from 'playwright';

const i = process.argv.indexOf('--chromium');
const executablePath =
  i === -1 ? (process.env.POC_CHROMIUM ?? '/opt/pw-browsers/chromium') : process.argv[i + 1];
const CSP = "default-src 'self'; script-src 'unsafe-inline'; style-src 'self'";

const html = `<!doctype html><html><head></head><body>
<div id="a">style element</div><div id="b">constructed sheet</div>
<div id="c">CSSOM el.style</div><div id="d">setAttribute style</div>
<script>
const s = document.createElement('style');
s.textContent = '#a{color:rgb(255,0,0)}';
document.head.append(s);
const sheet = new CSSStyleSheet();
sheet.replaceSync('@layer osdlabel{#b{color:rgb(0,128,0)}}');
document.adoptedStyleSheets = [sheet];
document.getElementById('c').style.color = 'rgb(0,0,255)';
document.getElementById('d').setAttribute('style', 'color: rgb(255,0,255)');
const host = document.createElement('div');
document.body.append(host);
const root = host.attachShadow({ mode: 'open' });
root.innerHTML = '<span id="e">shadow adopted</span>';
const inner = new CSSStyleSheet();
inner.replaceSync('#e{color:rgb(0,128,0)}');
root.adoptedStyleSheets = [inner];
const color = (el) => getComputedStyle(el).color;
window.__r = {
  styleElement: color(document.getElementById('a')),
  constructedSheetDocument: color(document.getElementById('b')),
  cssomInlineStyle: color(document.getElementById('c')),
  setAttributeStyle: color(document.getElementById('d')),
  constructedSheetShadowRoot: color(root.getElementById('e')),
};
</script></body></html>`;

const browser = await chromium.launch(executablePath === 'playwright' ? {} : { executablePath });
try {
  const page = await browser.newPage();
  const messages = [];
  page.on('console', (m) => messages.push(m.text()));
  await page.route('http://localhost/csp', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/html', 'content-security-policy': CSP },
      body: html,
    }),
  );
  await page.goto('http://localhost/csp');
  const result = await page.evaluate(() => window.__r);
  // Unstyled text is rgb(0, 0, 0); anything else means the mechanism applied.
  const applied = Object.fromEntries(
    Object.entries(result).map(([k, v]) => [k, v !== 'rgb(0, 0, 0)']),
  );
  console.log(
    JSON.stringify(
      { browser: browser.version(), csp: CSP, computedColor: result, applied, messages },
      null,
      1,
    ),
  );
} finally {
  await browser.close();
}

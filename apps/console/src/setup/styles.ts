/**
 * The wizard's stylesheet, inlined into the page.
 *
 * The token names are phase 8's, copied from `apps/console-ui/public/styles.css`, so the
 * wizard and the console it becomes read as one thing. The font *files* are not copied: they
 * are self-hosted assets of the UI package, which does not exist on this branch and is not
 * served during setup. The stacks therefore fall through to the same system faces phase 8
 * lists as its fallbacks, and the page looks right on a box with nothing built yet.
 *
 * One stylesheet, no external request, no JavaScript required to read the page.
 */

export const SETUP_CSS = `
:root {
  --bg: #f5f8f6;
  --surface: #ffffff;
  --sunk: #eef3f0;
  --ink: #172420;
  --muted: #5b6b65;
  --line: #d5ded9;
  --line-soft: #e6ece9;
  --wa: #1f8a5b;
  --wa-soft: #dff2e8;
  --mem: #6a5bc4;
  --mem-soft: #e9e5f8;
  --warn: #b8741a;
  --warn-soft: #f7ebd6;
  --bad: #a93c34;
  --bad-soft: #f8e2e0;
  --display: 'Bricolage Grotesque', 'Avenir Next', Helvetica, Arial, sans-serif;
  --body: 'Source Sans 3', 'Segoe UI', Helvetica, Arial, sans-serif;
  --mono: 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace;
  --r: 6px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    --bg: #101614;
    --surface: #182019;
    --sunk: #131a17;
    --ink: #e7ede9;
    --muted: #9aaaa3;
    --line: #2c3a33;
    --line-soft: #22302a;
    --wa: #4cc48a;
    --wa-soft: #173626;
    --mem: #a89bf0;
    --mem-soft: #2a2547;
    --warn: #e0a54f;
    --warn-soft: #3c2d13;
    --bad: #e8736b;
    --bad-soft: #3a1d1b;
  }
}
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 16px/1.55 var(--body);
}
.wrap { max-width: 820px; margin: 0 auto; padding: 28px 20px 64px; }
header.top { display: flex; align-items: baseline; gap: 12px; margin-bottom: 22px; }
header.top h1 { font: 700 22px/1.2 var(--display); margin: 0; }
header.top .host { font: 12px var(--mono); color: var(--muted); }
ol.rail {
  list-style: none; display: flex; flex-wrap: wrap; gap: 6px;
  margin: 0 0 24px; padding: 0; font-size: 13px;
}
ol.rail li {
  display: flex; align-items: center; gap: 7px;
  border: 1px solid var(--line); border-radius: var(--r);
  background: var(--surface); padding: 5px 10px; color: var(--muted);
}
ol.rail li .n {
  font: 600 11px var(--mono); background: var(--sunk); color: var(--muted);
  border-radius: var(--r); padding: 1px 6px;
}
ol.rail li.done { border-color: var(--wa); background: var(--wa-soft); color: var(--ink); }
ol.rail li.done .n { background: var(--wa); color: var(--surface); }
ol.rail li.skipped { border-style: dashed; }
ol.rail li.current { border-color: var(--mem); background: var(--mem-soft); color: var(--ink); }
ol.rail li.current .n { background: var(--mem); color: var(--surface); }
section.step {
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--r); padding: 22px;
}
section.step h2 { font: 600 19px/1.25 var(--display); margin: 0 0 6px; }
section.step p.lead { color: var(--muted); margin: 0 0 18px; }
label { display: block; font-weight: 600; margin: 0 0 5px; }
label + .hint { color: var(--muted); font-size: 13px; margin: -3px 0 8px; }
input[type='text'], input[type='email'], input[type='url'], select {
  width: 100%; padding: 9px 11px; font: 15px var(--body);
  color: var(--ink); background: var(--sunk);
  border: 1px solid var(--line); border-radius: var(--r);
}
input.mono, .mono { font-family: var(--mono); }
.row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 16px; }
button, .btn {
  font: 600 15px var(--body); padding: 9px 16px; cursor: pointer;
  border-radius: var(--r); border: 1px solid var(--wa);
  background: var(--wa); color: #fff; text-decoration: none; display: inline-block;
}
button.ghost, .btn.ghost { background: var(--surface); color: var(--ink); border-color: var(--line); }
.note, .warn, .bad {
  border: 1px solid var(--line); border-radius: var(--r);
  padding: 11px 13px; margin: 14px 0; font-size: 14px;
}
.note { background: var(--sunk); }
.warn { background: var(--warn-soft); border-color: var(--warn); }
.bad { background: var(--bad-soft); border-color: var(--bad); }
code, pre { font-family: var(--mono); font-size: 13px; }
pre {
  background: var(--sunk); border: 1px solid var(--line-soft);
  border-radius: var(--r); padding: 11px 13px; overflow-x: auto;
}
ul.caps { list-style: none; padding: 0; margin: 0; }
ul.caps li { padding: 7px 0; border-bottom: 1px solid var(--line-soft); }
ul.caps li:last-child { border-bottom: 0; }
ul.caps li .later { color: var(--muted); font-size: 13px; }
.qr {
  display: block; width: min(320px, 80vw); height: auto; margin: 16px 0;
  background: #fff; border: 1px solid var(--line); border-radius: var(--r); padding: 10px;
}
.state { font: 12px var(--mono); color: var(--muted); }
.checkline { display: flex; gap: 9px; align-items: flex-start; font-weight: 400; }
.checkline input { margin-top: 4px; }
a { color: var(--mem); }
`;

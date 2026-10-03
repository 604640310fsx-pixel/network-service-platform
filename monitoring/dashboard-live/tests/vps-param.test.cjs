const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'app.js'), 'utf8');

test('?vps= preselects a server on first load without persisting it', () => {
  assert.match(source, /new URLSearchParams\(location\.search\)\.get\('vps'\)/);
  assert.match(source, /lastVps:urlVps\|\|savedVps\|\|'DMIT Premium'/);
  // Bounded, control-character-free value; unknown names fall back via loadVpsTargets.
  assert.match(source, /v\.length<=128/);
  assert.match(source, /if\(!names\.includes\(state\.lastVps\)\)state\.lastVps=/);
  const init = source.slice(source.indexOf('const urlVps='), source.indexOf('const state = {'));
  assert.doesNotMatch(init, /setItem/);
});

test('app.js still loads under Node without browser globals', () => {
  assert.doesNotThrow(() => require('../static/app.js'));
});

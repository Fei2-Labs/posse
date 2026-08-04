const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, '..', 'mobile/client/app.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'mobile/client/style.css'), 'utf8');

test('mobile quick keys distinguish taps from swipe gestures', () => {
  assert.match(app, /const QUICK_KEY_SWIPE_THRESHOLD = 8/);
  assert.match(app, /addEventListener\('touchstart',[\s\S]*\{ passive: true \}\)/);
  assert.match(app, /addEventListener\('touchmove',[\s\S]*touchMoved = true;[\s\S]*\{ passive: true \}\)/);
  assert.match(app, /addEventListener\('touchcancel', resetTouch, \{ passive: true \}\)/);
  assert.match(app, /resetTouch\(\);\s*if \(moved\) return;\s*e\.preventDefault\(\)/);
  assert.doesNotMatch(app, /touchstart', \(e\) => \{ e\.preventDefault\(\)/);
  assert.match(styles, /#shortcut-bar \{[\s\S]*touch-action: pan-x;/);
  assert.match(styles, /\.key-btn \{[\s\S]*touch-action: pan-x;/);
});

test('dangerous quick keys still arm and fire only after a valid tap', () => {
  const touchEnd = app.match(/btn\.addEventListener\('touchend',[\s\S]*?\}, \{ passive: false \}\);/)?.[0] || '';
  assert.match(touchEnd, /if \(moved\) return/);
  assert.match(touchEnd, /if \(DANGEROUS_KEYS\.has\(key\)\)/);
  assert.match(touchEnd, /if \(armedKeyBtn === btn\)[\s\S]*fire\(\)/);
  assert.match(touchEnd, /armedKeyTimer = setTimeout\(disarmKey, 2000\)/);
});

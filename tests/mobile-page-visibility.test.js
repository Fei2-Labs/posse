const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const stylePath = path.join(__dirname, '..', 'mobile', 'client', 'style.css');
const styleCss = fs.readFileSync(stylePath, 'utf8');

test('cc-chat page stays hidden until .active is applied', () => {
  assert.equal(
    /#cc-chat-page\.page\s*\{\s*display:\s*flex;/m.test(styleCss),
    false,
    'cc-chat page must not force display:flex outside the .active state',
  );

  assert.equal(
    /#cc-chat-page\.active\s*\{\s*display:\s*flex;/m.test(styleCss),
    true,
    'cc-chat page should only be visible in the active state',
  );
});

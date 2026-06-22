// Prints the build version <major>.<minor>.<patch>.
//
// patch is TIME-BASED (seconds since 2026-01-01 UTC), NOT the git commit count.
// Commit count collides across parallel branches/worktrees: two branches both at
// "base + N commits" produce the same 1.2.N, so concurrent sessions kept shipping
// duplicate version numbers. A monotonic clock makes every build's number unique
// and increasing with no cross-session coordination. The exact commit identity of
// a build is carried separately by the build-stamp sha shown in the app footer.
const pkg = require('../package.json');

const parts = String(pkg.version || '1.2.0').split('.');
const major = parts[0] || '1';
const minor = parts[1] || '2';

const EPOCH = Date.UTC(2026, 0, 1);
const patch = Math.max(0, Math.floor((Date.now() - EPOCH) / 1000));

process.stdout.write(`${major}.${minor}.${patch}`);

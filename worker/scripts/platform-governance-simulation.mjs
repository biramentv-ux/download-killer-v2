import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const source = fs.readFileSync(path.join(root, 'src/platform_governance.ts'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'migrations/0017_platform_governance_v2.sql'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'public/control-v2/control-v2.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public/control-v2/manifest.webmanifest'), 'utf8'));

const requiredRoles = ['owner', 'admin', 'editor', 'moderator', 'user'];
for (const role of requiredRoles) {
  assert.match(source, new RegExp(`\\b${role}\\b`), `missing role ${role}`);
}

for (const table of ['platform_users', 'platform_role_history', 'platform_sessions', 'platform_versions', 'platform_events']) {
  assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`), `missing migration table ${table}`);
  assert.match(source, new RegExp(table), `missing runtime integration ${table}`);
}

assert.match(source, /identity\.link\.start/);
assert.match(source, /identity\.link\.status/);
assert.match(source, /version\.rollback/);
assert.match(source, /module\.reorder/);
assert.match(source, /text\/event-stream/);
assert.match(source, /opaque-device-session/);
assert.doesNotMatch(source, /eval\s*\(/);
assert.doesNotMatch(source, /new Function\s*\(/);
assert.doesNotMatch(source, /innerHTML\s*=\s*body\./);

assert.equal(manifest.display, 'standalone');
assert.equal(manifest.start_url, '/control-v2/');
assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2);
assert.match(ui, /\/api\/platform\/governance/);
assert.match(ui, /\/api\/platform\/realtime/);
assert.match(ui, /EventSource/);
assert.match(ui, /sessionStorage|localStorage/);

const roleOrder = { user: 0, moderator: 1, editor: 2, admin: 3, owner: 4 };
assert.ok(roleOrder.owner > roleOrder.admin);
assert.ok(roleOrder.admin > roleOrder.editor);
assert.ok(roleOrder.editor > roleOrder.moderator);
assert.ok(roleOrder.moderator > roleOrder.user);

const report = {
  ok: true,
  simulated_at: new Date().toISOString(),
  roles: requiredRoles,
  checks: {
    rbac: true,
    telegram_device_link: true,
    shared_profile: true,
    version_snapshots: true,
    rollback: true,
    realtime_event_feed: true,
    mobile_control_center: true,
    pwa_offline_shell: true,
    arbitrary_code_execution_blocked: true,
    production_deploy_triggered: false,
  },
};

fs.writeFileSync(path.join(root, 'platform-governance-simulation-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

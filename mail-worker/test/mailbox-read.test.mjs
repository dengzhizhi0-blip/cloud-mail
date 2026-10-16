import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createMailboxReadUrl, readMailbox } from '../src/service/mailbox-read.js';

const SECRET = 'PRIVATE_MAILBOX_SIGNING_SECRET';
const ORIGIN = 'https://mail.example.invalid';
const MAILBOX = { accountId: 1, email: 'box1@example.invalid' };

// D1-shaped read-only transport backed by in-memory SQLite, so the tests
// exercise the actual bound SQL and SQLite collation rather than a query stub.
class FakeD1 {
	constructor(t, { empty = false } = {}) {
		this.sqlite = new DatabaseSync(':memory:');
		t.after(() => this.sqlite.close());
		this.calls = [];
		this.sqlite.exec(`
			CREATE TABLE account (account_id INTEGER PRIMARY KEY, email TEXT, is_del INTEGER DEFAULT 0);
			CREATE TABLE email (
				email_id INTEGER PRIMARY KEY, account_id INTEGER, to_email TEXT,
				subject TEXT, create_time TEXT, text TEXT, content TEXT,
				type INTEGER DEFAULT 0, is_del INTEGER DEFAULT 0
			);
			INSERT INTO account VALUES (1, 'BOX1@EXAMPLE.INVALID', 0),
				(2, 'box2@example.invalid', 0), (3, 'deleted@example.invalid', 1);
		`);
		if (!empty) {
			for (let id = 101; id <= 155; id++) this.addMail(id, 1, MAILBOX.email);
			this.addMail(201, 2, 'box2@example.invalid');
			this.addMail(202, 1, 'box1+other@example.invalid');
			this.addMail(203, 1, MAILBOX.email, { type: 1 });
			this.addMail(204, 1, MAILBOX.email, { isDel: 1 });
			this.addMail(205, 3, 'deleted@example.invalid');
			this.addMail(206, 2, MAILBOX.email);
		}
	}

	addMail(id, accountId, toEmail, { type = 0, isDel = 0 } = {}) {
		this.sqlite.prepare('INSERT INTO email VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
			.run(id, accountId, toEmail, `subject ${id}`, '2026-10-16 01:02:03',
				`body ${id}`, `<p>body ${id}</p>`, type, isDel);
	}

	prepare(sql) {
		assert.match(sql.trim(), /^SELECT\s/i, 'pickup endpoint must only read D1');
		const call = { sql, bindings: null };
		this.calls.push(call);
		return {
			bind: (...bindings) => {
				call.bindings = bindings;
				return {
					first: async () => {
						const row = this.sqlite.prepare(sql).get(...bindings);
						return row ? { ...row } : null;
					},
					all: async () => {
						this.beforeAll?.();
						return { results: this.sqlite.prepare(sql).all(...bindings).map(row => ({ ...row })) };
					},
				};
			},
		};
	}
}

function environment(t, options) {
	return { jwt_secret: SECRET, db: new FakeD1(t, options) };
}

async function link(env, mailbox = MAILBOX) {
	return createMailboxReadUrl(`${ORIGIN}/account/add?ignored=value`, env, mailbox);
}

async function body(response, status) {
	assert.equal(response.status, status);
	assert.equal(response.headers.get('Cache-Control'), 'no-store');
	assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
	assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8');
	const value = await response.json();
	assert.equal(value.code, status);
	assert.ok(!JSON.stringify(value).includes(SECRET));
	return value;
}

test('links use a deterministic per-mailbox HMAC, HTTPS origin, and three canonical parameters', async (t) => {
	const env = environment(t);
	const original = await link(env);
	const url = new URL(original);
	assert.equal(url.origin, ORIGIN);
	assert.equal(url.pathname, '/api/mailbox/read');
	assert.deepEqual([...url.searchParams.keys()], ['email', 'accountId', 'key']);
	assert.equal(url.searchParams.get('email'), MAILBOX.email);
	assert.equal(url.searchParams.get('accountId'), '1');
	assert.match(url.searchParams.get('key'), /^[A-Za-z0-9_-]{43}$/);
	assert.ok(!original.includes(SECRET));
	assert.equal(original, await link(env, { accountId: 1, email: MAILBOX.email.toUpperCase() }));
	assert.equal(original, await createMailboxReadUrl('http://mail.example.invalid/api/account/add', env, MAILBOX));
	assert.notEqual(url.searchParams.get('key'), new URL(await link(env,
		{ accountId: 2, email: 'box2@example.invalid' })).searchParams.get('key'));
	assert.equal(env.db.calls.length, 0, 'link generation needs no database or KV write');
});

test('a valid link returns only the latest 50 active received messages for its exact mailbox', async (t) => {
	const env = environment(t);
	const request = new Request(await link(env));
	assert.equal(request.headers.get('Authorization'), null);
	assert.equal(request.headers.get('Cookie'), null);
	assert.equal('kv' in env, false);
	const value = await body(await readMailbox(request, env), 200);
	assert.equal(value.message, 'success');
	assert.deepEqual(value.data.list.map(row => row.emailId), Array.from({ length: 50 }, (_, i) => 155 - i));
	for (const row of value.data.list) {
		assert.equal(row.accountId, MAILBOX.accountId);
		assert.equal(row.toEmail, MAILBOX.email);
		assert.deepEqual(Object.keys(row).sort(),
			['accountId', 'content', 'createTime', 'emailId', 'subject', 'text', 'toEmail']);
	}
	assert.equal(env.db.calls.length, 2);
	for (const call of env.db.calls) assert.deepEqual(call.bindings, [1, MAILBOX.email]);
});

test('email matching is case-insensitive but percent, underscore and apostrophe stay literal SQL data', async (t) => {
	const env = environment(t, { empty: true });
	const mailbox = { accountId: 4, email: "it's%_mail@example.invalid" };
	assert.doesNotThrow(() => env.db.sqlite.prepare('INSERT INTO account VALUES (?, ?, 0)').run(4, mailbox.email));
	env.db.addMail(1, 4, mailbox.email.toUpperCase());
	env.db.addMail(2, 4, "it'sZZmail@example.invalid");
	const url = new URL(await link(env, mailbox));
	url.searchParams.set('email', mailbox.email.toUpperCase());
	const value = await body(await readMailbox(new Request(url), env), 200);
	assert.deepEqual(value.data.list.map(row => row.emailId), [1]);
	for (const call of env.db.calls) {
		assert.deepEqual(call.bindings, [4, mailbox.email]);
		assert.ok(!call.sql.includes(mailbox.email));
		assert.ok(!/\bLIKE\b/i.test(call.sql));
	}
});

test('altering the account ID, email or signature is rejected before querying D1', async (t) => {
	const env = environment(t);
	const original = await link(env);
	for (const [name, value] of [
		['accountId', '2'], ['email', 'box2@example.invalid'],
		['key', 'A'.repeat(43)], ['key', 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.signature'],
	]) {
		const url = new URL(original);
		url.searchParams.set(name, value);
		await body(await readMailbox(new Request(url), env), 401);
	}
	assert.equal(env.db.calls.length, 0);
});

test('missing, duplicate, unknown and malformed parameters are rejected', async (t) => {
	const env = environment(t);
	const original = await link(env);
	const changes = [
		url => url.searchParams.delete('key'),
		url => url.searchParams.append('key', url.searchParams.get('key')),
		url => url.searchParams.append('email', MAILBOX.email),
		url => url.searchParams.append('accountId', '1'),
		url => url.searchParams.append('allReceive', '1'),
		url => { url.pathname += '/'; },
	];
	for (const value of ['0', '-1', '01', '1.0', '1e0', '1\n', '1\r\n', '9007199254740992', '1 OR 1=1']) {
		changes.push(url => url.searchParams.set('accountId', value));
	}
	for (const value of ['other@example.invalid\n', 'not-an-email', 'a b@example.invalid', 'a@localhost']) {
		changes.push(url => url.searchParams.set('email', value));
	}
	for (const value of ['', 'short', 'A'.repeat(42) + 'B', 'A'.repeat(43) + '=', '%'.repeat(43)]) {
		changes.push(url => url.searchParams.set('key', value));
	}
	for (const change of changes) {
		const url = new URL(original);
		change(url);
		await body(await readMailbox(new Request(url), env), 401);
	}
	assert.equal(env.db.calls.length, 0);
});

test('only GET is accepted and errors keep response privacy headers', async (t) => {
	const env = environment(t);
	const url = await link(env);
	for (const method of ['POST', 'HEAD', 'OPTIONS', 'DELETE']) {
		const response = await readMailbox(new Request(url, { method }), env);
		assert.equal(response.headers.get('Allow'), 'GET');
		await body(response, 405);
	}
	assert.equal(env.db.calls.length, 0);
});

test('a deleted or absent account returns 404 even if active message rows remain', async (t) => {
	const env = environment(t);
	for (const mailbox of [
		{ accountId: 3, email: 'deleted@example.invalid' },
		{ accountId: 999, email: 'absent@example.invalid' },
		{ accountId: 1, email: 'different@example.invalid' },
	]) {
		await body(await readMailbox(new Request(await link(env, mailbox)), env), 404);
	}
	const url = await link(env);
	env.db.sqlite.exec('DELETE FROM account WHERE account_id = 1');
	await body(await readMailbox(new Request(url), env), 404);
	assert.equal(env.db.calls.length, 4, 'failed account lookup must not query email');
});

test('secret rotation revokes old links without a database query', async (t) => {
	const env = environment(t);
	const url = await link(env);
	env.jwt_secret = 'ROTATED_PRIVATE_SIGNING_SECRET';
	await body(await readMailbox(new Request(url), env), 401);
	assert.equal(env.db.calls.length, 0);
	await body(await readMailbox(new Request(await link(env)), env), 200);
});

test('an empty mailbox is success and deletion during a read cannot disclose messages', async (t) => {
	const empty = environment(t, { empty: true });
	assert.deepEqual((await body(await readMailbox(new Request(await link(empty)), empty), 200)).data, { list: [] });
	const env = environment(t);
	env.db.beforeAll = () => env.db.sqlite.exec('UPDATE account SET is_del = 1 WHERE account_id = 1');
	assert.deepEqual((await body(await readMailbox(new Request(await link(env)), env), 200)).data, { list: [] });
});

test('missing bindings and transport errors fail with generic 503 and do not expose raw errors', async (t) => {
	const env = environment(t);
	const url = await link(env);
	for (const unavailable of [undefined, {}, { jwt_secret: SECRET }, { db: env.db }, { jwt_secret: '', db: env.db }]) {
		await body(await readMailbox(new Request(url), unavailable), 503);
	}
	const unavailable = {
		jwt_secret: SECRET,
		db: { prepare() { throw new Error(`RAW_DATABASE_ERROR ${SECRET}`); } },
	};
	const value = await body(await readMailbox(new Request(url), unavailable), 503);
	assert.equal(value.message, 'Mailbox unavailable');
	assert.ok(!JSON.stringify(value).includes('RAW_DATABASE_ERROR'));
	await assert.rejects(() => createMailboxReadUrl(ORIGIN, {}, MAILBOX), /Mailbox URL unavailable/);
	await assert.rejects(() => createMailboxReadUrl(ORIGIN, env, { ...MAILBOX, accountId: 0 }), /Mailbox URL unavailable/);
	await assert.rejects(() => createMailboxReadUrl(ORIGIN, env, { ...MAILBOX, email: MAILBOX.email + '\n' }), /Mailbox URL unavailable/);
});

test('legacy addresses accepted by the existing account API still receive working links', async (t) => {
	const env = environment(t, { empty: true });
	const addresses = [
		'a'.repeat(65) + '@example.invalid',
		'a'.repeat(260) + '@example.invalid',
		'legacy@-existing.example.invalid',
	];
	for (const [index, email] of addresses.entries()) {
		const mailbox = { accountId: index + 10, email };
		env.db.sqlite.prepare('INSERT INTO account VALUES (?, ?, 0)').run(mailbox.accountId, email);
		env.db.addMail(index + 1, mailbox.accountId, email);
		const value = await body(await readMailbox(new Request(await link(env, mailbox)), env), 200);
		assert.deepEqual(value.data.list.map(row => row.toEmail), [email]);
	}
});

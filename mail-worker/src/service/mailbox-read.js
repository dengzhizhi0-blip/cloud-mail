const READ_PATH = '/api/mailbox/read';
const SIGNING_CONTEXT = 'cloud-mail:mailbox-read:v1';
const encoder = new TextEncoder();
// Keep the existing account API's address grammar, including legacy long
// addresses, so appending a read URL cannot break an existing account page.
const emailPattern = /^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~.-]+@([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/;

function mailboxIdentity(accountId, email) {
	const id = String(accountId);
	if (!/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id)) || String(Number(id)) !== id) {
		return null;
	}
	if (typeof email !== 'string' || email.trim() !== email || !emailPattern.test(email)) {
		return null;
	}
	return { accountId: Number(id), email: email.toLowerCase() };
}

function signingInput(identity) {
	return encoder.encode(`${SIGNING_CONTEXT}\n${identity.accountId}\n${identity.email}`);
}

function base64url(bytes) {
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signatureBytes(value) {
	if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
	const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='), char => char.charCodeAt(0));
	return base64url(bytes) === value ? bytes : null;
}

function hasSecret(env) {
	return typeof env?.jwt_secret === 'string' && env.jwt_secret.length > 0;
}

async function signingKey(env) {
	return crypto.subtle.importKey('raw', encoder.encode(env.jwt_secret),
		{ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function jsonResponse(status, data = null) {
	const headers = {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff',
	};
	if (status === 405) headers.Allow = 'GET';
	return new Response(JSON.stringify({
		code: status,
		message: status === 200 ? 'success' : 'Mailbox unavailable',
		data,
	}), { status, headers });
}

export async function createMailboxReadUrl(requestUrl, env, accountRow) {
	const identity = mailboxIdentity(accountRow?.accountId, accountRow?.email);
	if (!identity || !hasSecret(env)) throw new Error('Mailbox URL unavailable');
	const source = new URL(requestUrl);
	if (!['https:', 'http:'].includes(source.protocol)) throw new Error('Mailbox URL unavailable');
	const url = new URL(READ_PATH, source.origin);
	url.protocol = 'https:';
	const key = await signingKey(env);
	const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, signingInput(identity)));
	url.search = new URLSearchParams({
		email: identity.email,
		accountId: String(identity.accountId),
		key: base64url(signature),
	}).toString();
	return url.toString();
}

export async function readMailbox(request, env) {
	if (request.method !== 'GET') return jsonResponse(405);
	if (!hasSecret(env) || typeof env?.db?.prepare !== 'function') return jsonResponse(503);
	try {
		const url = new URL(request.url);
		const params = url.searchParams;
		if (url.pathname !== READ_PATH || params.size !== 3
			|| !['email', 'accountId', 'key'].every(name => params.getAll(name).length === 1)) {
			return jsonResponse(401);
		}
		const identity = mailboxIdentity(params.get('accountId'), params.get('email'));
		const signature = signatureBytes(params.get('key'));
		if (!identity || !signature) return jsonResponse(401);
		const key = await signingKey(env);
		if (!await crypto.subtle.verify('HMAC', key, signature, signingInput(identity))) {
			return jsonResponse(401);
		}

		const account = await env.db.prepare(`
			SELECT account_id AS accountId, email FROM account
			WHERE account_id = ? AND email COLLATE NOCASE = ? AND is_del = 0
			LIMIT 1
		`).bind(identity.accountId, identity.email).first();
		if (!account) return jsonResponse(404);

		// The join rechecks deletion at the moment mail is read, including when
		// the account was deleted after the lookup above.
		const result = await env.db.prepare(`
			SELECT e.email_id AS emailId, e.account_id AS accountId,
				e.to_email AS toEmail, e.subject, e.create_time AS createTime,
				e.text, e.content
			FROM email AS e
			INNER JOIN account AS a ON a.account_id = e.account_id
				AND a.email COLLATE NOCASE = e.to_email AND a.is_del = 0
			WHERE e.account_id = ? AND e.to_email COLLATE NOCASE = ?
				AND e.type = 0 AND e.is_del = 0
			ORDER BY e.email_id DESC LIMIT 50
		`).bind(identity.accountId, identity.email).all();
		if (!Array.isArray(result?.results)) return jsonResponse(503);
		return jsonResponse(200, { list: result.results });
	} catch {
		return jsonResponse(503);
	}
}

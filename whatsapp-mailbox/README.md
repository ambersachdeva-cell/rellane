# WhatsApp mailbox

Meta will only hand you an inbound message by POSTing to a public address. This
holds that gap and nothing else: it takes what Meta posts, keeps it until the Mac
collects it, and forgets it.

It cannot send a WhatsApp message and has no way to obtain a token. Sending stays
on the Mac, where the token is, so there remains exactly one place a message to a
customer can originate from.

## Deploy

You need a Cloudflare account. Check its current pricing and limits before deployment.

```bash
npm install -g wrangler
wrangler login

cd whatsapp-mailbox
wrangler kv namespace create MAILBOX        # copy the id it prints into wrangler.toml
wrangler deploy
```

Then three secrets. `wrangler` prompts for each; none of them is typed into a file:

```bash
wrangler secret put VERIFY_TOKEN     # any random string you invent, used once by Meta
wrangler secret put APP_SECRET       # Meta app dashboard → Settings → Basic → App secret
wrangler secret put COLLECT_SECRET   # another random string; only the Mac ever sends it
```

Generate the two you invent with:

```bash
openssl rand -hex 32
```

## What to put in Meta

On the WhatsApp → Configuration page:

- **Callback URL** — `https://rellane-whatsapp-mailbox.<your-subdomain>.workers.dev/webhook`
- **Verify token** — the VERIFY_TOKEN above

Press **Verify and save**. Meta calls the URL once; if it comes back green the
endpoint is proven. Then **Manage** the webhook fields and subscribe to
`messages`.

## Check it

Message the business number from your own phone, then:

```bash
curl -H "Authorization: Bearer <COLLECT_SECRET>" \
  https://rellane-whatsapp-mailbox.<your-subdomain>.workers.dev/collect
```

Your message comes back once. Run it again and the mailbox is empty — that is
correct; collection clears it.

## What it keeps

Per message: the sender's number, their WhatsApp profile name, the text, the
timestamp, and Meta's message id. Not the rest of Meta's payload. Anything
uncollected is deleted after seven days regardless.

## What it refuses

Meta signs every POST with the app secret. An unsigned or wrongly signed request
is dropped, so anyone who finds this URL cannot post a message into your
business. Refusals answer 200 rather than an error, because a 4xx makes Meta
retry and retrying a forgery is worse than dropping it.

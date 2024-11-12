To install dependencies:

```sh
bun install
```

To run:

```sh
bun run dev
```

or

```sh
bun run dev --port 54321
```

if you want to sns webhook to run, add the env to the .env file

```
WEBHOOK_URL=http://localhost:3000/api/ses_callback
```

open http://localhost:3000

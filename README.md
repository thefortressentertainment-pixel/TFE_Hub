# Fortress Hub

Local setup for the Fortress receipt hub app.

## Requirements

- Node.js installed
- Redis running locally on `127.0.0.1:6379`
- PostgreSQL running locally on `127.0.0.1:5432`
- Postgres database `fortress` created with user `postgres` / password `postgres`

## Install dependencies

```bash
cd ~/fortress-hub
npm install
```

## Start services

From the project root, run everything in one go:

```bash
cd ~/fortress-hub
npm run dev
```

That launches the backend, worker, and frontend together. If you prefer separate terminals, use:

1. Backend
```bash
cd ~/fortress-hub
npm run start:backend
```

2. Worker
```bash
cd ~/fortress-hub
npm run start:worker
```

3. Frontend
```bash
cd ~/fortress-hub
npm run start:frontend
```

## Defaults

- Backend: `http://localhost:4002`
- Upload endpoint: `http://localhost:4002/api/upload`
- Job status: `http://localhost:4002/api/job/:id`
- Receipts list: `http://localhost:4002/api/receipts`

## Notes

- The frontend is configured to upload files to `localhost:4002`.
- The backend and worker default to local Redis/Postgres when `REDIS_URL` and `DATABASE_URL` are not provided.
- If port `4002` is already in use, stop the existing backend instance before starting a second one.
